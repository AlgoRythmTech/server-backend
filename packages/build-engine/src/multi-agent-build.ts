// Multi-agent build orchestrator.
//
// The pattern Cursor 2.0 / Replit Agent / Convex's durable agents use:
// instead of one LLM doing everything in one shot, split the build into
// stages owned by different sub-agents, each with its own scope and
// system prompt. Catches failure modes that single-shot builds miss
// (architect proposes a file plan a single agent would never produce;
// reviewer catches issues the builder didn't see).
//
// Stages:
//   1. ARCHITECT  → produces a FilePlan: list of files with rationale,
//                   dependencies, and acceptance criteria per file.
//                   No code yet. Plain JSON output.
//   2. BUILDER    → consumes the FilePlan, emits dyad-write blocks for
//                   each planned file. This is the existing
//                   streamBuildWithTools loop, just primed with the
//                   plan instead of the raw brief.
//   3. REVIEWER   → reads the bundle, runs the static gate, runs the
//                   testing agent, and proposes fixes via dyad-write.
//                   Up to 2 reviewer iterations.
//
// Each stage shares cost ledger entries with the same operationId so
// the workspace's Replay tab shows the full build flow as one timeline.

import { request } from 'undici';
import { z } from 'zod';
import {
  buildSpecialistSystemPrompt,
  routeModel,
  type Specialist,
} from '@argo/agent';

// ──────────────────────────────────────────────────────────────────────
// Stage 1: Architect
// ──────────────────────────────────────────────────────────────────────

export const FilePlanEntry = z.object({
  path: z.string().min(1).max(160),
  /** Why this file exists. Plain English. */
  rationale: z.string().min(20).max(400),
  /** Files this one imports / depends on (paths in the same plan). */
  dependsOn: z.array(z.string()).default([]),
  /** Acceptance criteria the reviewer will check. */
  acceptance: z.array(z.string().min(8).max(240)).default([]),
  /** Approximate size: one of small (< 80 lines), medium (< 200), large (< 400). */
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  /** True for files that get the // argo:generated header. */
  argoGenerated: z.boolean().default(true),
});
export type FilePlanEntry = z.infer<typeof FilePlanEntry>;

export const FilePlan = z.object({
  /** Title of the planned operation, in plain English. */
  title: z.string().min(4).max(120),
  /** One-paragraph summary the reviewer reads before checking output. */
  summary: z.string().min(40).max(800),
  /** Architecture diagram in mermaid-flowchart syntax. */
  mermaid: z.string().min(20).max(2000),
  files: z.array(FilePlanEntry).min(8).max(80),
  /** Dependencies that need to land in package.json. */
  dependencies: z.array(z.string()).default([]),
  /** Open questions the architect has — surfaced to the operator if any. */
  openQuestions: z.array(z.string()).default([]),
});
export type FilePlan = z.infer<typeof FilePlan>;

const ARCHITECT_SYSTEM_PROMPT = `
You are Argo's architect agent. The operator described a workflow they
want to ship. Your job: produce a FILE PLAN — NOT the code yet.

The builder agent will consume your plan and emit one <dyad-write> per
file you list. The reviewer will check that every file you planned exists
and meets your stated acceptance criteria.

# Hard rules

- Output ONLY a single JSON object matching the FilePlan schema.
- 8 minimum files. 28+ for fullstack. 38+ for ai_agent_builder.
- Every file MUST have a rationale (1-2 sentences explaining WHY this
  file exists separately) and at least one acceptance criterion the
  reviewer can check.
- The mermaid diagram must show: ingress (form / webhook / cron) →
  validation → handler → side effects (db, mailer, agent calls).
- Dependencies: only packages that exist on npm. No invented packages.
- The plan must be coherent. Don't list \`server.js\` AND \`src/index.js\`
  as separate entry points — pick one.
- DON'T list files that don't exist yet but might. Ship a complete
  project; cuts are the operator's decision.

# Quality bar

A senior engineer reviewing the plan should say "yes, this is
production-shaped." That means: split per concern, not per file count.
Routes file per resource. Schema files in one folder. Mailer templates
as separate files. Tests in tests/. README + .env.example required.

# Output

JSON object only. No prose. No markdown fences.
`.trim();

export interface RunArchitectArgs {
  specialist: Specialist;
  /** The brief or operator's free-text description. */
  userPrompt: string;
  /** Cost-of-being-wrong context that should NOT be in the plan but the
   *  architect should respect (compliance constraints, voice tone, etc.). */
  augmentation?: {
    integrations?: readonly string[];
    auth?: string;
    dataClassification?: string;
  };
  model?: string;
  signal?: AbortSignal;
}

export async function runArchitect(args: RunArchitectArgs): Promise<FilePlan> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const apiBase = process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1';
  const routing = routeModel('architect', args.model ? { primary: args.model } : {});
  const candidates = routing.candidates;
  let lastErr: Error | null = null;
  // Layer the specialist's patterns on top of the architect prompt so
  // a fullstack_app architect knows to plan for vite + react + tailwind,
  // an ai_agent_builder architect knows to plan for the agent SDK, etc.
  const layeredPrompt =
    ARCHITECT_SYSTEM_PROMPT +
    '\n\n# Specialist context\n\n' +
    buildSpecialistSystemPrompt(args.specialist).slice(0, 3000);

  for (const model of candidates) {
    try {
      const json = await callJson({
        apiBase, apiKey, model,
        system: layeredPrompt,
        user: composeArchitectUserMessage(args),
        ...(args.signal ? { signal: args.signal } : {}),
      });
      const parsed = FilePlan.safeParse(json);
      if (!parsed.success) {
        lastErr = new Error(`FilePlan schema mismatch: ${parsed.error.message.slice(0, 400)}`);
        continue;
      }
      return parsed.data;
    } catch (err) {
      const e = err as Error & { status?: number };
      const transient =
        e.status === 404 || e.status === 400 ||
        /model_not_found|invalid model/i.test(e.message ?? '');
      if (!transient) throw err;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('runArchitect: no candidate model succeeded');
}

function composeArchitectUserMessage(args: RunArchitectArgs): string {
  const lines: string[] = [];
  lines.push('# Operator brief');
  lines.push('');
  lines.push(args.userPrompt);
  lines.push('');
  if (args.augmentation) {
    lines.push('# Constraints');
    if (args.augmentation.integrations?.length) {
      lines.push(`Integrations expected: ${args.augmentation.integrations.join(', ')}`);
    }
    if (args.augmentation.auth) lines.push(`Auth: ${args.augmentation.auth}`);
    if (args.augmentation.dataClassification) {
      lines.push(`Data classification: ${args.augmentation.dataClassification}`);
    }
    lines.push('');
  }
  lines.push('Return the FilePlan JSON now.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Stage 3: Reviewer (the "second pair of eyes")
//
// Reads a bundle (path -> contents), reads the FilePlan it was supposed
// to satisfy, and produces a structured review with severity-graded
// findings. The orchestrator treats severity:bad findings as
// build-blocking (forces another auto-fix cycle); severity:warn is
// recorded but doesn't block.
// ──────────────────────────────────────────────────────────────────────

export const ReviewFinding = z.object({
  severity: z.enum(['bad', 'warn', 'info']),
  category: z.enum([
    'missing_file',
    'incomplete_implementation',
    'unsafe_code',
    'unmet_acceptance',
    'missing_test',
    'missing_doc',
    'naming',
    'other',
  ]),
  file: z.string().nullable(),
  message: z.string().min(8).max(400),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

export const ReviewReport = z.object({
  passed: z.boolean(),
  findings: z.array(ReviewFinding).max(40),
  summary: z.string().min(20).max(600),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

const REVIEWER_SYSTEM_PROMPT = `
You are Argo's reviewer agent. The builder produced a bundle to satisfy
a FilePlan from the architect. Your job: read both, find what's wrong,
report it as structured findings.

# Hard rules

- Output ONLY a single JSON object matching the ReviewReport schema.
- "passed" is TRUE only when every severity:bad finding is empty AND
  every planned file exists. severity:warn does not block.
- Categories:
    missing_file              : a file from the plan isn't in the bundle
    incomplete_implementation : a file is a stub / TODO / "// rest of code"
    unsafe_code               : security / data-handling issue
    unmet_acceptance          : the file's acceptance criterion not met
    missing_test              : tests/eval-suite.js missing or empty
    missing_doc               : README.md missing required sections
    naming                    : confusing or inconsistent names
    other                     : anything else
- Don't be polite. If the bundle ships console.log, mark unsafe_code.
- "summary" is one paragraph the operator reads at the top of the
  workspace. Voice: senior engineer signing off (or refusing to).

# What you cannot do

- You don't propose code changes. You report findings only. The builder
  takes another pass to address them. Keep your output structured.
`.trim();

export interface RunReviewerArgs {
  plan: FilePlan;
  files: ReadonlyMap<string, string>;
  model?: string;
  signal?: AbortSignal;
}

export async function runReviewer(args: RunReviewerArgs): Promise<ReviewReport> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const apiBase = process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1';
  const routing = routeModel('reviewer', args.model ? { primary: args.model } : {});
  const candidates = routing.candidates;
  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      const json = await callJson({
        apiBase, apiKey, model,
        system: REVIEWER_SYSTEM_PROMPT,
        user: composeReviewerUserMessage(args),
        maxTokens: 3500,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      const parsed = ReviewReport.safeParse(json);
      if (!parsed.success) {
        lastErr = new Error(`ReviewReport schema mismatch: ${parsed.error.message.slice(0, 400)}`);
        continue;
      }
      return parsed.data;
    } catch (err) {
      const e = err as Error & { status?: number };
      const transient =
        e.status === 404 || e.status === 400 ||
        /model_not_found|invalid model/i.test(e.message ?? '');
      if (!transient) throw err;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('runReviewer: no candidate model succeeded');
}

function composeReviewerUserMessage(args: RunReviewerArgs): string {
  const lines: string[] = [];
  lines.push('# Plan');
  lines.push(JSON.stringify(args.plan, null, 2).slice(0, 6000));
  lines.push('');
  lines.push(`# Bundle (${args.files.size} files)`);
  lines.push('');
  // Embed each file with a clear delimiter. Cap the per-file body so a
  // 10K-line generated file doesn't blow the context window.
  for (const [path, contents] of args.files) {
    lines.push(`## ${path}`);
    lines.push('```');
    lines.push(contents.slice(0, 4000));
    if (contents.length > 4000) lines.push(`/* ...(${contents.length - 4000} more chars truncated)... */`);
    lines.push('```');
    lines.push('');
  }
  lines.push('Return the ReviewReport JSON now.');
  return lines.join('\n');
}

/**
 * Render a ReviewReport as the additional context the auto-fix loop
 * passes to the builder for the next cycle.
 */
export function renderReviewAsAutoFixPrompt(review: ReviewReport): string {
  if (review.passed) return '';
  const bad = review.findings.filter((f) => f.severity === 'bad');
  const warn = review.findings.filter((f) => f.severity === 'warn');
  const lines: string[] = [];
  lines.push('# Reviewer report — fix the bad findings before the build can ship.');
  lines.push('');
  lines.push(review.summary);
  lines.push('');
  if (bad.length > 0) {
    lines.push('## Bad findings (BLOCKING):');
    for (const f of bad) {
      lines.push(`- [${f.category}] ${f.file ?? '(no file)'}: ${f.message}`);
    }
    lines.push('');
  }
  if (warn.length > 0) {
    lines.push('## Warnings:');
    for (const f of warn) {
      lines.push(`- [${f.category}] ${f.file ?? '(no file)'}: ${f.message}`);
    }
    lines.push('');
  }
  lines.push('Re-emit ONLY the affected files via <dyad-write>. End with one <dyad-chat-summary>.');
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

interface CallJsonArgs {
  apiBase: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

async function callJson(args: CallJsonArgs): Promise<unknown> {
  // GPT-5.5 requires max_completion_tokens (not max_tokens) and does not
  // support temperature values other than the default (1).
  const isGpt55 = args.model.startsWith('gpt-5.5');
  const body: Record<string, unknown> = {
    model: args.model,
    response_format: { type: 'json_object' as const },
    max_completion_tokens: args.maxTokens ?? 16384,
    messages: [
      { role: 'system' as const, content: args.system },
      { role: 'user' as const, content: args.user },
    ],
  };
  if (!isGpt55) body.temperature = 0.3;
  const res = await request(`${args.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(args.signal ? { signal: args.signal } : {}),
    bodyTimeout: 90_000,
    headersTimeout: 30_000,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    const e: Error & { status?: number } = new Error(
      `OpenAI ${args.model} -> ${res.statusCode}: ${text.slice(0, 300)}`,
    );
    e.status = res.statusCode;
    throw e;
  }
  const parsed = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = parsed.choices?.[0]?.message?.content ?? '';
  return JSON.parse(content);
}
