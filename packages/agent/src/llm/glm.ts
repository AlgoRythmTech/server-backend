/**
 * GLM-5.1 Client — Z.AI's flagship coding model via NVIDIA NIM.
 *
 * GLM-5.1 is #1 on SWE-Bench Pro (58.4), beating Claude Opus 4.6 and GPT-5.4.
 * 754B parameters (40B active MoE), 200K context, 128K output tokens.
 *
 * Architecture: OpenAI-compatible API via NVIDIA NIM (integrate.api.nvidia.com).
 *
 * Usage in Argo:
 *   - PRIMARY for code generation (building phase) — it's the best coding model
 *   - GPT-5.5 for structured output (workflow maps, classifications, digests)
 *   - GLM-5.1 for the actual code files — 128K output = can emit 30+ files in one shot
 *
 * The combo of GPT-5.5 (structured reasoning) + GLM-5.1 (raw code generation)
 * is the most powerful code generation stack available in 2026. No competitor
 * has this — Replit uses Sonnet 4, Lovable uses Claude, Emergent uses GPT-5.5 alone.
 */

import { request } from 'undici';
import pino from 'pino';

const log = pino({ name: 'glm-client', level: process.env.LOG_LEVEL ?? 'info' });

export interface GlmConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface GlmCompletionArgs {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  stream?: boolean;
}

export interface GlmCompletionResult {
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number;
}

export class GlmClient {
  private readonly cfg: GlmConfig;

  constructor(cfg: GlmConfig) {
    this.cfg = cfg;
    if (cfg.enabled && !cfg.apiKey) {
      log.warn('GLM_ENABLED=true but NVIDIA_NIM_API_KEY missing — GLM-5.1 will be unavailable');
    }
    if (cfg.enabled && cfg.apiKey) {
      log.info({ model: cfg.model }, 'GLM-5.1 client initialized — #1 SWE-Bench Pro coding model active');
    }
  }

  static fromEnv(): GlmClient {
    return new GlmClient({
      apiKey: process.env.NVIDIA_NIM_API_KEY ?? '',
      apiBase: process.env.NVIDIA_NIM_API_BASE ?? 'https://integrate.api.nvidia.com/v1',
      model: process.env.GLM_MODEL ?? 'z-ai/glm-5.1',
      enabled: (process.env.GLM_ENABLED ?? '').toLowerCase() === 'true',
      timeoutMs: 600_000, // 10 min — GLM-5.1 can run for hours on complex tasks
    });
  }

  get isEnabled(): boolean {
    return this.cfg.enabled && !!this.cfg.apiKey;
  }

  /**
   * Complete a prompt using GLM-5.1.
   * Uses OpenAI-compatible API via NVIDIA NIM.
   */
  async complete(args: GlmCompletionArgs): Promise<GlmCompletionResult> {
    if (!this.isEnabled) {
      throw new Error('GLM-5.1 not enabled — set GLM_ENABLED=true and NVIDIA_NIM_API_KEY');
    }

    const started = Date.now();

    // NVIDIA NIM uses OpenAI-compatible format
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
      max_tokens: args.maxTokens ?? 16384,
      stream: false,
    };

    const res = await request(`${this.cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      bodyTimeout: this.cfg.timeoutMs,
      headersTimeout: 300_000,
    });

    const text = await res.body.text();
    const durationMs = Date.now() - started;

    if (res.statusCode >= 400) {
      const err: Error & { status?: number } = new Error(
        `GLM-5.1 ${this.cfg.model} → ${res.statusCode}: ${text.slice(0, 300)}`,
      );
      err.status = res.statusCode;
      log.error({ status: res.statusCode, durationMs }, 'GLM-5.1 completion failed');
      throw err;
    }

    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const content = parsed.choices?.[0]?.message?.content ?? '';

    log.info(
      {
        model: this.cfg.model,
        promptTokens: parsed.usage?.prompt_tokens,
        completionTokens: parsed.usage?.completion_tokens,
        durationMs,
      },
      'GLM-5.1 completion success',
    );

    return {
      text: content,
      model: this.cfg.model,
      promptTokens: parsed.usage?.prompt_tokens ?? null,
      completionTokens: parsed.usage?.completion_tokens ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null,
      durationMs,
    };
  }

  /**
   * Stream a completion using GLM-5.1.
   * Yields chunks as they arrive — for the build stream UI.
   */
  async *stream(args: GlmCompletionArgs): AsyncGenerator<{
    delta: string;
    fullText: string;
    done: boolean;
    totalTokens: number | null;
  }> {
    if (!this.isEnabled) {
      throw new Error('GLM-5.1 not enabled');
    }

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
      max_tokens: args.maxTokens ?? 32768,
      stream: true,
    };

    const res = await request(`${this.cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      bodyTimeout: 0,
      headersTimeout: 300_000,
    });

    if (res.statusCode >= 400) {
      const errText = await res.body.text();
      throw new Error(`GLM-5.1 stream ${res.statusCode}: ${errText.slice(0, 300)}`);
    }

    let buffer = '';
    let fullText = '';
    let totalTokens: number | null = null;
    const decoder = new TextDecoder();

    for await (const chunk of res.body) {
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
          yield { delta: '', fullText, done: true, totalTokens };
          return;
        }
        let parsed: { choices?: Array<{ delta?: { content?: string } }>; usage?: { total_tokens?: number } };
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta?.content ?? '';
        if (parsed.usage?.total_tokens !== undefined) totalTokens = parsed.usage.total_tokens;
        if (delta) {
          fullText += delta;
          yield { delta, fullText, done: false, totalTokens };
        }
      }
    }

    yield { delta: '', fullText, done: true, totalTokens };
  }
}

/**
 * Determine the best model combo for a given task.
 *
 * Strategy:
 *   - Code generation (building) → GLM-5.1 (best SWE-bench score)
 *   - Structured output (maps, classifications) → GPT-5.5 (best JSON mode)
 *   - Fast tasks (naming, chat) → GPT-4o or Groq
 *   - Fallback → Emergent universal key
 */
export function selectBestModelForTask(task: 'build' | 'structured' | 'fast' | 'iterate'): {
  provider: 'glm' | 'openai' | 'groq';
  model: string;
  reason: string;
} {
  const glmEnabled = (process.env.GLM_ENABLED ?? '').toLowerCase() === 'true' && !!process.env.NVIDIA_NIM_API_KEY;

  switch (task) {
    case 'build':
      if (glmEnabled) {
        return {
          provider: 'glm',
          model: process.env.GLM_MODEL ?? 'z-ai/glm-5.1',
          reason: '#1 SWE-Bench Pro (58.4), 128K output, best coding model available',
        };
      }
      return {
        provider: 'openai',
        model: process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-5.5',
        reason: 'GLM-5.1 not available, falling back to GPT-5.5',
      };

    case 'iterate':
      // For iterations, GLM-5.1 is better because it can reason over
      // the full existing codebase (200K context) and produce targeted patches
      if (glmEnabled) {
        return {
          provider: 'glm',
          model: process.env.GLM_MODEL ?? 'z-ai/glm-5.1',
          reason: '200K context handles full codebase for surgical iterations',
        };
      }
      return {
        provider: 'openai',
        model: process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-5.5',
        reason: 'GLM-5.1 not available, using GPT-5.5 for iteration',
      };

    case 'structured':
      return {
        provider: 'openai',
        model: process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-5.5',
        reason: 'GPT-5.5 has best JSON mode for structured output',
      };

    case 'fast':
      return {
        provider: 'openai',
        model: process.env.OPENAI_MODEL_FALLBACK ?? 'gpt-4o',
        reason: 'Fast model for naming, chat, classification',
      };
  }
}
