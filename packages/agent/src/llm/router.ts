import type { z } from 'zod';
import type { AgentInvocationKind, AgentProvider } from '@argo/shared-types';
import { OpenAiClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { getProviderPreference } from './model-router.js';
import pino from 'pino';

const log = pino({ name: 'llm-router', level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Router that picks the right model + provider for a given invocation kind.
 *
 * Provider selection is governed by PROVIDER_PREFERENCE env var:
 *   - 'openai'    (default) — OpenAI primary for simple kinds; Anthropic for
 *                    building/repair (preserving existing hard-coded splits).
 *   - 'anthropic' — Anthropic primary for all kinds.
 *   - 'auto'      — Anthropic for complex tasks (building, repair, testing),
 *                    OpenAI for simpler ones (classify, digest, email).
 *
 * Cross-provider fallback: if the primary provider fails with a transient
 * error, the router retries with the other provider before giving up.
 */

export type LlmCallArgs<TSchema extends z.ZodTypeAny> = {
  kind: AgentInvocationKind;
  prompt: string;
  schema: TSchema;
  schemaName: string;
};

export type LlmCallResult = {
  provider: AgentProvider;
  model: string;
  rawText: string;
  parsedJson: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
};

export interface LlmRouter {
  complete<TSchema extends z.ZodTypeAny>(args: LlmCallArgs<TSchema>): Promise<LlmCallResult>;
}

/** Invocation kinds considered "complex" — routed to Anthropic in auto mode. */
const COMPLEX_KINDS: ReadonlySet<string> = new Set([
  'building_generate_file',
  'testing_diagnose_failure',
  'repair_propose_patch',
  'repair_propose_smaller_patch',
]);

/**
 * Routing table — maps invocation kind to (provider, model). The `provider`
 * field is the *legacy default* provider. When PROVIDER_PREFERENCE is set,
 * resolveProvider() may override it.
 */
export const ROUTING_TABLE: Record<
  AgentInvocationKind,
  {
    provider: AgentProvider;
    modelEnv: string;
    defaultModel: string;
    anthropicModel: string;
    maxTokens: number;
    temperature: number;
  }
> = {
  listening_extract_intent: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 1500,
    temperature: 0.1,
  },
  mapping_generate_map: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 4000,
    temperature: 0.2,
  },
  mapping_apply_edit: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 2000,
    temperature: 0.2,
  },
  building_generate_file: {
    provider: 'anthropic',
    modelEnv: 'ANTHROPIC_MODEL_BUILD',
    defaultModel: 'claude-opus-4-7',
    anthropicModel: 'claude-opus-4-6',
    maxTokens: 8000,
    temperature: 0.0,
  },
  testing_diagnose_failure: {
    provider: 'anthropic',
    modelEnv: 'ANTHROPIC_MODEL_BUILD',
    defaultModel: 'claude-opus-4-7',
    anthropicModel: 'claude-opus-4-6',
    maxTokens: 4000,
    temperature: 0.1,
  },
  running_parse_inbound_reply: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 1000,
    temperature: 0.1,
  },
  running_compose_digest: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 1500,
    temperature: 0.5,
  },
  running_classify_submission: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 1500,
    temperature: 0.2,
  },
  running_draft_outbound_email: {
    provider: 'openai',
    modelEnv: 'OPENAI_MODEL_PRIMARY',
    defaultModel: 'gpt-5.5',
    anthropicModel: process.env.ANTHROPIC_MODEL_PRIMARY ?? 'claude-sonnet-4-6',
    maxTokens: 1500,
    temperature: 0.4,
  },
  repair_propose_patch: {
    provider: 'anthropic',
    modelEnv: 'ANTHROPIC_MODEL_BUILD',
    defaultModel: 'claude-opus-4-7',
    anthropicModel: 'claude-opus-4-6',
    maxTokens: 6000,
    temperature: 0.1,
  },
  repair_propose_smaller_patch: {
    provider: 'anthropic',
    modelEnv: 'ANTHROPIC_MODEL_BUILD',
    defaultModel: 'claude-opus-4-7',
    anthropicModel: 'claude-opus-4-6',
    maxTokens: 4000,
    temperature: 0.0,
  },
};

/**
 * Resolve the effective provider for a given invocation kind, taking
 * PROVIDER_PREFERENCE into account.
 */
export function resolveProvider(kind: AgentInvocationKind): AgentProvider {
  const pref = getProviderPreference();
  const route = ROUTING_TABLE[kind];

  if (pref === 'anthropic') return 'anthropic';
  if (pref === 'auto') return COMPLEX_KINDS.has(kind) ? 'anthropic' : 'openai';
  // 'openai' — preserve the existing per-kind defaults (some kinds like
  // building_generate_file already default to anthropic).
  return route.provider;
}

export class DefaultLlmRouter implements LlmRouter {
  constructor(
    private readonly openai: OpenAiClient,
    private readonly anthropic: AnthropicClient,
  ) {}

  static fromEnv(): DefaultLlmRouter {
    return new DefaultLlmRouter(OpenAiClient.fromEnv(), AnthropicClient.fromEnv());
  }

  async complete<TSchema extends z.ZodTypeAny>(args: LlmCallArgs<TSchema>): Promise<LlmCallResult> {
    const route = ROUTING_TABLE[args.kind];
    const effectiveProvider = resolveProvider(args.kind);

    // Determine primary model based on effective provider.
    const model = effectiveProvider === 'anthropic'
      ? (process.env[route.modelEnv] ?? route.anthropicModel)
      : (process.env[route.modelEnv] ?? route.defaultModel);

    // Attempt primary provider.
    try {
      return await this.callProvider(effectiveProvider, {
        model,
        prompt: args.prompt,
        schema: args.schema,
        schemaName: args.schemaName,
        maxTokens: route.maxTokens,
        temperature: route.temperature,
      });
    } catch (primaryErr) {
      const e = primaryErr as Error & { status?: number };
      // Retry on transient errors AND auth failures (401 = key expired/invalid,
      // fall back to Emergent universal key which may still work).
      const isTransient =
        e.status === 401 ||
        e.status === 429 ||
        e.status === 500 ||
        e.status === 502 ||
        e.status === 503 ||
        /overloaded|rate_limit|capacity|timeout|connection|api_key|unauthorized/i.test(e.message ?? '');

      if (!isTransient) throw primaryErr;

      // Cross-provider fallback.
      const fallbackProvider: AgentProvider = effectiveProvider === 'anthropic' ? 'openai' : 'anthropic';
      const fallbackModel = fallbackProvider === 'anthropic'
        ? route.anthropicModel
        : route.defaultModel;

      log.warn(
        { kind: args.kind, primaryProvider: effectiveProvider, fallbackProvider, err: e.message },
        'primary provider failed, attempting cross-provider fallback',
      );

      try {
        return await this.callProvider(fallbackProvider, {
          model: fallbackModel,
          prompt: args.prompt,
          schema: args.schema,
          schemaName: args.schemaName,
          maxTokens: route.maxTokens,
          temperature: route.temperature,
        });
      } catch (fallbackErr) {
        log.error(
          { kind: args.kind, fallbackProvider, err: (fallbackErr as Error).message },
          'cross-provider fallback also failed',
        );
        // Throw the original error — it's usually more informative.
        throw primaryErr;
      }
    }
  }

  private async callProvider<TSchema extends z.ZodTypeAny>(
    provider: AgentProvider,
    args: {
      model: string;
      prompt: string;
      schema: TSchema;
      schemaName: string;
      maxTokens: number;
      temperature: number;
    },
  ): Promise<LlmCallResult> {
    if (provider === 'openai') {
      return this.openai.completeJson(args);
    }
    return this.anthropic.completeJson(args);
  }

  /**
   * Free-form text completion for the conversational chat assistant.
   * Uses the classifier-tier model (cheap + fast) by default.
   */
  async completeText(args: {
    kind: string;
    operationId?: string;
    ownerId: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    store: { insert(doc: Record<string, unknown>): Promise<void> };
  }): Promise<{ text: string; model: string; invocationId: string; promptTokens: number | null; completionTokens: number | null }> {
    const model = process.env.ARGO_MODEL_CLASSIFIER ?? process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-4o';
    const invocationId = `inv_chat_${Date.now()}`;
    const start = Date.now();

    const result = await this.openai.completeText({
      model,
      systemPrompt: args.systemPrompt,
      userPrompt: args.userPrompt,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
    });

    // Persist the invocation for audit / replay.
    await args.store.insert({
      id: invocationId,
      operationId: args.operationId ?? null,
      ownerId: args.ownerId,
      kind: args.kind,
      status: 'completed',
      provider: 'openai',
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: null,
      durationMs: Date.now() - start,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      errorMessage: null,
    }).catch(() => undefined);

    return { ...result, invocationId };
  }
}
