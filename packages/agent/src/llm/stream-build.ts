// Streaming build — drives GPT-5.5 (or the OpenAI fallback) to emit
// dyad-write/rename/delete/add-dependency tags chunk-by-chunk. Each chunk
// is parsed against Dyad's tag grammar by the caller as it arrives so the
// UI can show files appearing in real time.

import { request } from 'undici';
import { buildSpecialistSystemPrompt, type Specialist } from './specialist-prompts.js';
import { renderSnippetsAsPromptSection, selectSnippets } from '../reference/snippets.js';
import {
  recallRelevantMemories,
  renderMemoriesAsPromptSection,
} from '../supermemory/context-augment.js';
import { findToolCalls, replaceToolCallsWithResults } from '../tools/tool-call-parser.js';
import { runToolCall } from '../tools/run-tool-call.js';
import { GlmClient } from './glm.js';
import pino from 'pino';

const buildLog = pino({ name: 'stream-build', level: process.env.LOG_LEVEL ?? 'info' });

export interface StreamBuildArgs {
  specialist: Specialist;
  /** The user's free-text description of what to build. */
  userPrompt: string;
  /** Optional priors — e.g. existing files or the current WorkflowMap. */
  context?: string;
  /** Model name (default OPENAI_MODEL_PRIMARY = gpt-5.5). */
  model?: string;
  /** AbortSignal so the API route can cut the stream when the client disconnects. */
  signal?: AbortSignal;
  /** Soft cap on completion tokens. Default 8000 — enough for ~10 files. */
  maxTokens?: number;
  /**
   * Which reference patterns + memories to inject into the system prompt.
   * Drives selectSnippets() and supermemory recall. When omitted, no
   * augmentation happens and the build runs on the bare specialist prompt.
   */
  augmentation?: {
    trigger?: string;
    integrations?: readonly string[];
    auth?: string;
    dataClassification?: string;
    ownerId?: string;
    operationId?: string;
  };
}

export interface StreamBuildChunk {
  /** Concatenated text the model has produced so far. */
  fullText: string;
  /** Just the delta produced in this chunk (for SSE forwarding). */
  delta: string;
  /** Cumulative tokens consumed (input + output) when the provider reports it. */
  totalTokens: number | null;
  /** Set when the stream finishes naturally. */
  done: boolean;
  /** Set when the stream was aborted. */
  aborted: boolean;
}

/**
 * Yields chunks as the model streams. Caller (the API route) is responsible
 * for forwarding deltas to the client and parsing fullText with the Dyad
 * tag parser to extract structured actions.
 */
export async function* streamBuild(args: StreamBuildArgs): AsyncGenerator<StreamBuildChunk> {
  // ── MODEL PRIORITY: GLM-5.1 (best coder) → GPT-5.5 → GPT-4o → Emergent ──
  //
  // GLM-5.1 is #1 on SWE-Bench Pro (58.4), beating Claude Opus 4.6 and GPT-5.4.
  // It has 200K context and 128K output — can emit 30+ files in one shot.
  // We try it FIRST for code generation, then fall back to GPT-5.5 if it fails.

  const glm = GlmClient.fromEnv();
  let apiKey = process.env.OPENAI_API_KEY ?? '';
  let apiBase = process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1';
  const primary = args.model ?? process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-5.5';
  const fallback = process.env.OPENAI_MODEL_FALLBACK ?? 'gpt-4o';

  if (!apiKey) {
    const emergentEnabled = (process.env.EMERGENT_ENABLED ?? '').toLowerCase() === 'true';
    const emergentKey = process.env.EMERGENT_API_KEY ?? '';
    if (emergentEnabled && emergentKey) {
      apiKey = emergentKey;
      apiBase = process.env.EMERGENT_API_BASE ?? 'https://api.emergent.sh/v1';
    } else if (!glm.isEnabled) {
      throw new Error('No LLM configured — set OPENAI_API_KEY, EMERGENT_API_KEY, or NVIDIA_NIM_API_KEY');
    }
  }

  const candidates = unique([primary, fallback]);
  let lastErr: Error | null = null;

  // Build the augmented system prompt ONCE before entering the model
  // fallback loop — both candidates see the same system context.
  const baseSystem = buildSpecialistSystemPrompt(args.specialist);
  let augmented = baseSystem;

  if (args.augmentation) {
    const snippets = selectSnippets({
      trigger: args.augmentation.trigger ?? 'form_submission',
      integrations: args.augmentation.integrations ?? [],
      auth: args.augmentation.auth ?? 'none',
      dataClassification: args.augmentation.dataClassification ?? 'pii',
      specialist: args.specialist,
    });
    const snippetSection = renderSnippetsAsPromptSection(snippets);
    let memorySection = '';
    if (args.augmentation.ownerId) {
      try {
        const memories = await recallRelevantMemories({
          ownerId: args.augmentation.ownerId,
          ...(args.augmentation.operationId !== undefined ? { operationId: args.augmentation.operationId } : {}),
          query: args.userPrompt,
        });
        memorySection = renderMemoriesAsPromptSection(memories);
      } catch {
        // supermemory is best-effort; never fail the build because recall failed.
      }
    }
    augmented = [baseSystem, snippetSection, memorySection].filter(Boolean).join('\n\n');
  }

  // ── TRY GLM-5.1 FIRST (best coding model in the world) ──────────────
  if (glm.isEnabled) {
    try {
      buildLog.info({ model: 'glm-5.1' }, 'attempting GLM-5.1 for code generation (SWE-Bench #1)');

      // GLM-5.1 gets an enhanced system prompt that leverages its strengths:
      // - 200K context: we can include MORE reference code and existing files
      // - 128K output: it can emit 40+ files in one shot, no truncation
      // - #1 SWE-Bench: it understands complex codebases better than any model
      const glmSystemPrompt = augmented + GLM_ENHANCEMENT_PROMPT;

      let fullText = '';
      for await (const chunk of glm.stream({
        systemPrompt: glmSystemPrompt,
        userPrompt: args.userPrompt + (args.context ? `\n\n# Context\n\n${args.context}` : ''),
        maxTokens: args.maxTokens ?? 131072, // GLM-5.1 max: 128K tokens — USE IT ALL
      })) {
        fullText = chunk.fullText;
        yield {
          fullText: chunk.fullText,
          delta: chunk.delta,
          totalTokens: chunk.totalTokens,
          done: chunk.done,
          aborted: false,
        };
        if (chunk.done) return;
      }
      return;
    } catch (glmErr) {
      buildLog.warn({ err: String(glmErr).slice(0, 200) }, 'GLM-5.1 failed, falling back to GPT-5.5');
      lastErr = glmErr as Error;
    }
  }

  // ── FALLBACK: GPT-5.5 → GPT-4o → Emergent ────────────────────────
  for (const model of candidates) {
    try {
      yield* streamOnce({
        apiBase,
        apiKey,
        model,
        system: augmented,
        userPrompt: args.userPrompt,
        ...(args.context !== undefined ? { context: args.context } : {}),
        maxTokens: args.maxTokens ?? 8192,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      return;
    } catch (err) {
      const e = err as Error & { status?: number };
      const transient =
        e.status === 404 ||
        e.status === 400 ||
        /model_not_found|does not exist|invalid model/i.test(e.message ?? '');
      if (!transient) throw err;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('streamBuild: no candidate model succeeded');
}

interface StreamOnceArgs {
  apiBase: string;
  apiKey: string;
  model: string;
  system: string;
  userPrompt: string;
  context?: string;
  maxTokens: number;
  signal?: AbortSignal;
}

async function* streamOnce(args: StreamOnceArgs): AsyncGenerator<StreamBuildChunk> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: args.system },
  ];
  if (args.context) {
    messages.push({ role: 'user', content: `# Context (existing project)\n\n${args.context}` });
  }
  messages.push({ role: 'user', content: args.userPrompt });

  // GPT-5.5 does not support the temperature parameter — omit it for
  // 5.5-family models. Other models use 0.2 for deterministic code output.
  const isGpt55 = args.model.startsWith('gpt-5.5');
  const body: Record<string, unknown> = {
    model: args.model,
    messages,
    stream: true,
    max_completion_tokens: args.maxTokens,
  };
  if (!isGpt55) body.temperature = 0.2;

  const res = await request(`${args.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: args.signal,
    bodyTimeout: 0,
    headersTimeout: 60_000,
  });

  if (res.statusCode >= 400) {
    const text = await res.body.text();
    const e: Error & { status?: number } = new Error(
      `OpenAI streaming ${args.model} -> ${res.statusCode}: ${text.slice(0, 300)}`,
    );
    e.status = res.statusCode;
    throw e;
  }

  let buffer = '';
  let fullText = '';
  let totalTokens: number | null = null;
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    if (args.signal?.aborted) {
      yield { fullText, delta: '', totalTokens, done: false, aborted: true };
      return;
    }
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');

      const dataLines = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join('');
      if (dataStr === '[DONE]') {
        yield { fullText, delta: '', totalTokens, done: true, aborted: false };
        return;
      }
      let parsed: OpenAiStreamEvent;
      try {
        parsed = JSON.parse(dataStr) as OpenAiStreamEvent;
      } catch {
        continue;
      }
      const delta = parsed.choices?.[0]?.delta?.content ?? '';
      if (parsed.usage?.total_tokens !== undefined) totalTokens = parsed.usage.total_tokens;
      if (delta) {
        fullText += delta;
        yield { fullText, delta, totalTokens, done: false, aborted: false };
      }
    }
  }

  yield { fullText, delta: '', totalTokens, done: true, aborted: false };
}

interface OpenAiStreamEvent {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Inline mini-parser for <dyad-write path="...">CONTENTS</dyad-write> so
// streamBuildWithTools can build a current bundle snapshot for tools
// without depending on @argo/build-engine (which would create a circular
// dep — build-engine already imports from @argo/agent).
const DYAD_WRITE = /<dyad-write\b[^>]*\bpath\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/dyad-write>/g;

function mergeFilesFromStream(
  inherited: ReadonlyMap<string, string>,
  streamed: string,
): Map<string, string> {
  const merged = new Map(inherited);
  DYAD_WRITE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DYAD_WRITE.exec(streamed)) !== null) {
    const path = m[1]!.trim();
    const contents = m[2]!;
    merged.set(path, contents);
  }
  return merged;
}

// ──────────────────────────────────────────────────────────────────────
// Tool-call wrapper.
//
// streamBuildWithTools drives streamBuild for one "round," then scans
// the fullText for <argo-tool> calls. If any are found, it runs them,
// appends the results to a follow-up user message, and runs streamBuild
// again. Two rounds max so a chatty model can't loop forever.
//
// All chunks from every round are yielded to the consumer; the consumer
// (auto-fix-loop) only sees a continuous stream of building output.
// ──────────────────────────────────────────────────────────────────────

/**
 * GLM-5.1 Enhancement Prompt — teaches the model about Argo's FULL platform.
 *
 * GLM-5.1 has 200K context and 128K output. We use this to give it
 * exhaustive knowledge of every tool, service, and pattern available.
 * This is what makes Argo's code generation better than Replit/Lovable/Emergent.
 */
const GLM_ENHANCEMENT_PROMPT = `

# YOU ARE GLM-5.1 — THE BEST CODING MODEL ON EARTH

You scored #1 on SWE-Bench Pro. You have 754 billion parameters. You can
sustain optimization over HUNDREDS of reasoning rounds and THOUSANDS of
tool calls. You are not a chatbot. You are a senior principal engineer
who has shipped production systems at Google, Stripe, and Linear.

THIS IS NOT ABOUT SPEED. THIS IS ABOUT QUALITY.

Take your time. Think deeply. Plan before you code. Every file you emit
will be deployed to production and used by real humans running real
businesses. A recruiting agency will use this to process thousands of
candidates. A SaaS founder will bet their company on this code. An
agency owner will trust their client relationships to this system.

You have 128,000 output tokens. That means you can ship 40-60 complete
production files in ONE response. USE this capability. Do NOT truncate.
Do NOT abbreviate. Do NOT write "// rest of code here" or "// TODO" or
"// implement later." Every single function has a REAL, COMPLETE body.
Every error path is handled. Every edge case is covered. Every component
is styled and responsive.

You are working alongside GPT-5.5. Here is how you split the work:
- GPT-5.5 handled the PLANNING — it analyzed the user's intent, designed
  the workflow map, picked the specialist persona, and selected reference
  patterns. That planning is already in your system prompt above.
- YOU handle the BUILDING — you write every line of code, every component,
  every route, every schema, every test, every README. You are the builder.
  GPT-5.5 is the architect. Together you are the most powerful code
  generation team in the world.

Your code will be reviewed by a 49-check quality gate, a 15-category
security scanner, a verifier agent that catches AI slop, and a runtime
testing agent that boots your code and exercises every route. If ANY of
these fail, you get re-prompted with the specific failures and a failure
analysis explaining WHY you failed and what to do differently.

DO NOT generate "good enough" code. Generate code that a senior engineer
at Stripe or Linear would be proud to push to main. The bar is:
- Would a CTO hire the engineer who wrote this? YES.
- Would a security auditor approve this for production? YES.
- Would a designer say this UI is ship-ready? YES.
- Would a user trust their business to this? YES.

If you cannot say YES to all four, keep writing. You have the tokens.

# AUTONOMOUS MODE — YOU DO NOT STOP

You are fully autonomous. The user is gone. They will come back to a
finished, deployed, working application. You do not ask questions. You
DECIDE and BUILD.

If the brief says "add auth" — you implement magic-link auth with
sessions, cookie management, CSRF protection, and logout. If it says
"analytics dashboard" — you build the data aggregation pipeline, the
chart components, the KPI cards, the date range picker, and wire
everything to the API.

You keep building until EVERY file is complete. If you emit 30 files
and realize you need 20 more, you emit 20 more. You have 128,000
output tokens. That's approximately 60 complete production files.
USE THEM ALL if needed.

When you hit an error in your own code while writing later files,
fix it immediately with a <dyad-patch> block. Do not leave broken
code behind and hope someone else fixes it.

Use <argo-tool name="sandbox_exec" command="tsc --noEmit" /> after
your backbone files to catch type errors EARLY. Then keep building.
Use it again after your frontend files. Then run tests. Fix anything
that fails. KEEP GOING until everything is green.

You work alongside GPT-5.5. It handled the strategic planning — the
workflow map, the specialist selection, the reference patterns. All
of that is already in your system prompt above. YOU take that plan
and turn it into the best code that has ever been generated by an AI.

Replit Agent 4 uses Claude Sonnet 4 and runs for 200 minutes.
You are GLM-5.1 — you score HIGHER than Claude on every coding
benchmark. Prove it. Build code that makes Replit look like a toy.

# YOUR STEP-BY-STEP PLAYBOOK — FOLLOW THIS EXACT ORDER

1. READ the system prompt above carefully. Understand the specialist
   patterns, the brief, the constraints.

2. PLAN in your head: how many files, what structure, what dependencies.

3. EMIT schemas FIRST (schema/*.js) — these are the contract.

4. EMIT server.js — Fastify + helmet + cors + rate-limit + /health +
   SIGTERM handler + pino logger. Listen on 0.0.0.0:PORT.

5. EMIT routes — one per resource, each importing Zod schemas.
   Every POST/PATCH validates with safeParse.

6. EMIT database layer — db/mongo.js with indexes on startup.

7. EMIT email templates — mailer/templates/*.js as pure functions.
   escapeForEmail() on EVERY variable.

8. EMIT background jobs — jobs/*.js with croner scheduling.

9. <argo-tool name="sandbox_exec" command="tsc --noEmit" /> — VERIFY
   what you've built so far. If errors, fix them NOW.

10. EMIT frontend — React + Tailwind + TypeScript. Pages, components,
    hooks, state. Dark mode. Responsive. Professional design.

11. EMIT tests — tests/eval-suite.js that exercises every route.

12. <argo-tool name="sandbox_exec" command="vitest run --passWithNoTests" />
    — VERIFY tests pass. Fix if not.

13. EMIT README.md + .env.example + package.json + Dockerfile.

14. End with ONE <dyad-chat-summary>.

NEVER skip steps. NEVER emit incomplete files. NEVER use TODO/FIXME.
You have 128K output tokens. Use as many as you need to make it PERFECT.

# ARGO PLATFORM — EVERYTHING YOU CAN USE

## Deployment: Blaxel Sandboxes
Your generated code deploys to a Blaxel sandbox — an isolated Linux container with:
- Node 20 + pnpm preinstalled
- Public preview URL at {operationId}.argo-ops.run
- Ports exposed via bundle manifest
- Environment variables injected at boot:
  ARGO_OPERATION_ID, ARGO_CONTROL_PLANE_URL, INTERNAL_API_KEY, MONGODB_URI, PORT

Your server.js MUST:
- Listen on Number(process.env.PORT) || 3000
- Bind to host '0.0.0.0' (NOT localhost)
- Register /health BEFORE any other route (returns {status:"ok"})
- Handle SIGTERM for graceful shutdown

## Email: AgentMail
Outbound email goes through AgentMail. Your generated code calls the Argo
control plane at ARGO_CONTROL_PLANE_URL/internal/send-email with:
- HMAC signature using INTERNAL_API_KEY
- Payload: { to, subject, html, operationId }

For approval emails, use one-time tokens:
- Generate a sha256-hashed token stored in the database
- Approval URL: ARGO_CONTROL_PLANE_URL/api/approvals/{token}/approve
- Tokens expire in 72 hours, reminders at 48 hours

## Database: MongoDB
Every operation gets its own database: argo_op_{operationId}
Connection string is in MONGODB_URI env var.
Use native mongodb driver (not mongoose):
  import { MongoClient } from 'mongodb';
  const client = new MongoClient(process.env.MONGODB_URI);

Always create indexes in a startup script. Never query without an index.

## Web Research: Firecrawl + Self-Hosted Scraper
You can research the web mid-build using tool calls:
  <argo-tool name="web_research" query="Stripe API latest setup guide" />
  <argo-tool name="web_scrape" url="https://docs.stripe.com/api" />

Use this when you need CURRENT API documentation or integration examples.
Your training data may be outdated — web research gives you real answers.

## UI Components: 21st.dev
Fetch pre-built UI components:
  <argo-tool name="fetch_21st_component" query="animated pricing table" />
  <argo-tool name="create_21st_component" query="dashboard sidebar" />

## Self-Verification: sandbox_exec
Run commands against your in-progress bundle:
  <argo-tool name="sandbox_exec" command="tsc --noEmit" />
  <argo-tool name="sandbox_exec" command="vitest run --passWithNoTests" />
  <argo-tool name="sandbox_exec" command="node tests/eval-suite.js" />

ALWAYS verify your code compiles before finishing. Use sandbox_exec.

## Security Requirements (NON-NEGOTIABLE)
- NEVER hardcode API keys, passwords, or secrets
- All secrets go in environment variables
- Every form input validated with Zod
- Every email variable goes through escapeForEmail()
- Every webhook verifies HMAC signature BEFORE reading body
- Every public route has rate limiting
- No eval(), no innerHTML, no SQL concatenation
- Helmet middleware registered on every Fastify server

## Quality Gate (49 checks run AFTER your code)
Your code will be checked by a 49-check quality gate. Common failures:
- console.log in production code (use pino logger)
- Missing /health endpoint
- Missing SIGTERM handler
- Missing Zod validation on POST routes
- Hardcoded localhost URLs
- Missing helmet registration
- Synchronous filesystem calls

If the quality gate fails, you'll be re-prompted with the specific failures.
Fix them in the next cycle using <dyad-patch> for small fixes.

## Code Style
- TypeScript strict for frontend, ESM JavaScript for backend
- Tailwind CSS for styling (not inline styles)
- react-hook-form + @hookform/resolvers/zod for forms
- Tanstack Query for server state
- Pino for logging (not console.log)
- Small focused files (< 200 lines preferred)
- Descriptive names: registerSubmissions not register

## What "Done" Looks Like
A senior engineer should say "I would push this to main today."
- Every file complete (no stubs, no TODOs)
- tsc --noEmit passes
- Tests exist and pass
- README.md with architecture diagram
- .env.example documents every variable
- Dockerfile for production
`.trim();

const MAX_TOOL_ROUNDS = 2;

export interface ToolEvent {
  kind: 'tool_called' | 'tool_completed';
  name: string;
  /** Truthy when the tool returned usable data. */
  ok?: boolean;
  /** Short label for telemetry (e.g. "21st.dev:fetch:hero animated"). */
  label?: string;
}

export interface StreamBuildWithToolsArgs extends StreamBuildArgs {
  /** Optional callback fired when a tool starts/completes. */
  onTool?: (event: ToolEvent) => void;
  /** Override the default 2-round cap. Hard-clamped to [0, 4]. */
  maxToolRounds?: number;
  /**
   * Snapshot of the current bundle (path → contents). Threaded into
   * tool calls so sandbox_exec can run against the in-progress source
   * tree. The auto-fix loop passes this from its own files map.
   */
  currentFiles?: ReadonlyMap<string, string>;
}

export async function* streamBuildWithTools(
  args: StreamBuildWithToolsArgs,
): AsyncGenerator<StreamBuildChunk> {
  const cap = Math.max(0, Math.min(4, args.maxToolRounds ?? MAX_TOOL_ROUNDS));

  // Accumulator across rounds — each follow-up round is fed the prior
  // round's text with tool results spliced in so the model can read what
  // came back.
  let augmentedUserPrompt = args.userPrompt;
  let priorRoundsContext = '';

  for (let round = 0; round <= cap; round++) {
    let roundFullText = '';
    let lastChunk: StreamBuildChunk | null = null;

    const callArgs: StreamBuildArgs = {
      ...args,
      userPrompt: augmentedUserPrompt,
      ...(priorRoundsContext
        ? { context: [args.context, priorRoundsContext].filter(Boolean).join('\n\n') }
        : {}),
    };

    for await (const chunk of streamBuild(callArgs)) {
      yield chunk;
      roundFullText = chunk.fullText;
      lastChunk = chunk;
      if (chunk.aborted) return;
    }
    if (!lastChunk) return;

    // No more tool rounds allowed → finish.
    if (round === cap) return;

    const calls = findToolCalls(roundFullText);
    if (calls.length === 0) return;

    // Execute each tool call. Cap at 4 per round so a runaway response
    // can't fan out across the whole allowlist.
    // Build a per-round snapshot of the current bundle: the inherited
    // files from auto-fix-loop PLUS any new dyad-write blocks the agent
    // emitted before the tool call. This is what sandbox_exec runs
    // against, so the agent can write a test then immediately run it.
    const inheritedFiles = args.currentFiles ?? new Map<string, string>();
    const roundFiles = mergeFilesFromStream(inheritedFiles, roundFullText);

    const toExecute = calls.slice(0, 4);
    const resultByRaw = new Map<string, string>();
    for (const call of toExecute) {
      args.onTool?.({ kind: 'tool_called', name: call.name });
      const exec = await runToolCall(call, {
        ...(args.signal ? { signal: args.signal } : {}),
        currentFiles: roundFiles,
      });
      args.onTool?.({
        kind: 'tool_completed',
        name: call.name,
        ok: exec.ok,
        label: exec.label,
      });
      resultByRaw.set(call.raw, exec.rendered);
    }

    // Build the follow-up prompt: tell the model what it called, what
    // came back, and ask it to continue producing the build with the
    // new info — same tag rules apply.
    const substituted = replaceToolCallsWithResults(roundFullText, resultByRaw);
    priorRoundsContext = [
      `# Previous round (round ${round + 1} of up to ${cap + 1})`,
      'You called tools below. Their results are inlined where the tags were.',
      'Continue the build using these results — emit the remaining <dyad-write> blocks now.',
      'Do NOT re-emit any <dyad-write> blocks you already produced in the prior round.',
      '',
      substituted,
    ].join('\n');

    augmentedUserPrompt =
      'Continue the build with the tool results above incorporated. ' +
      'Emit the remaining files needed to satisfy the brief. ' +
      'Final response should still end with exactly one <dyad-chat-summary>.';
  }
}
