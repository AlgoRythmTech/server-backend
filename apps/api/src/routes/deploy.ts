import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  compileSpecCriteria,
  generateBundle,
  generateTestSuite,
  runAutoFixLoop,
  runQualityGate,
  runSecurityScan,
  generateTestSuiteForBundle,
  type AutoFixCycleEvent,
} from '@argo/build-engine';
import {
  buildManifest,
  composeManifestProse,
  pickSpecialist,
  renderBriefAsPrompt,
  renderManifestAsMarkdown,
} from '@argo/agent';
import {
  createBuildSandbox,
  createExecutionProvider,
  type OperationBundle,
} from '@argo/workspace-runtime';
import type { ProjectBrief, WorkflowMap } from '@argo/shared-types';
import { getPrisma } from '../db/prisma.js';
import { getMongo } from '../db/mongo.js';
import { requireSession } from '../plugins/auth-plugin.js';
import { appendActivity } from '../stores/activity-store.js';
import { broadcastToOwner } from '../realtime/socket.js';
import { logger } from '../logger.js';
import { loadEnvOverrides } from './env-vars.js';
import { dispatchWebhook } from '../services/webhook-dispatcher.js';

const DeployBody = z.object({
  operationId: z.string(),
});

const buildSandbox = createBuildSandbox();
const executionProvider = createExecutionProvider();

export async function registerDeployRoutes(app: FastifyInstance) {
  /**
   * POST /api/operations/deploy
   *
   * Two paths:
   *   1. If a ProjectBrief exists → run the full auto-fix loop with GPT-5.5
   *      (specialist persona + reference snippets + supermemory recall).
   *   2. If only a WorkflowMap exists → fall back to the deterministic
   *      generator. This preserves the old path for legacy operations.
   *
   * In both paths the bundle goes through the build sandbox (synthetic
   * submission) and only deploys to Blaxel if every assertion passes.
   */
  app.post('/api/operations/deploy', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return;
    const parsed = DeployBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const op = await getPrisma().operation.findFirst({
      where: { id: parsed.data.operationId, ownerId: session.userId },
    });
    if (!op) return reply.code(404).send({ error: 'not_found' });

    const { db } = await getMongo();

    // Prefer the brief over the legacy map — it's denser context.
    const briefDoc = await db
      .collection('project_briefs')
      .find({ operationId: op.id })
      .sort({ persistedAt: -1 })
      .limit(1)
      .next();
    const mapDoc = await db
      .collection('workflow_maps')
      .find({ operationId: op.id })
      .sort({ version: -1 })
      .limit(1)
      .next();
    if (!briefDoc && !mapDoc) return reply.code(409).send({ error: 'no_scope_yet' });

    await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'building' } });
    broadcastToOwner(session.userId, { type: 'operation_status', operationId: op.id, status: 'building' });

    // Broadcast thinking progress so the frontend shows what the agent is doing
    broadcastToOwner(session.userId, { type: 'deploy_progress', operationId: op.id, evt: { phase: 'thinking', message: 'Analyzing requirements and planning architecture...' } });

    const bundleVersion = (op.bundleVersion ?? 0) + 1;
    let bundle: OperationBundle | null = null;
    let generatedByModel = 'argo-deterministic';
    let aiCycles = 0;

    if (briefDoc) {
      // ── AI path: brief → GPT-5.5 + auto-fix loop ──────────────────────
      broadcastToOwner(session.userId, { type: 'deploy_progress', operationId: op.id, evt: { phase: 'thinking', message: 'GLM-5.1 + GPT-5.5 preparing to generate production code...' } });
      const brief = briefDoc as unknown as ProjectBrief & { buildPrompt?: string };
      const buildPrompt = brief.buildPrompt ?? renderBriefAsPrompt(brief);
      const specialist = pickSpecialist({
        archetype: 'form_workflow',
        triggerKind: brief.trigger,
        description: `${brief.name}\n${brief.outcome}`,
      });
      generatedByModel = process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-5.5';

      // Spec-as-tests: turn brief.successCriteria into runtime
      // assertions the testing agent will run after every cycle.
      const specCriteria = compileSpecCriteria({
        trigger: brief.trigger,
        successCriteria: brief.successCriteria ?? [],
      });

      try {
        const result = await runAutoFixLoop({
          specialist,
          userPrompt: buildPrompt,
          manifest: {
            operationId: op.id,
            operationSlug: op.slug,
            bundleVersion,
            workflowMapVersion: op.workflowMapVersion ?? 1,
            requiredEnv: ['ARGO_OPERATION_ID', 'ARGO_CONTROL_PLANE_URL', 'INTERNAL_API_KEY', 'MONGODB_URI'],
          },
          augmentation: {
            trigger: brief.trigger,
            integrations: brief.integrations,
            auth: brief.auth,
            dataClassification: brief.dataClassification,
            ownerId: session.userId,
          },
          specCriteria,
          // Multi-agent mode (architect → builder → reviewer) for the
          // heaviest specialists where the value of an explicit plan
          // and a reviewer pass is highest. Single-agent for the
          // lighter ones — saves the architect + reviewer LLM calls.
          multiAgent: specialist === 'fullstack_app' || specialist === 'ai_agent_builder' || specialist === 'multi_tenant_saas',
          onCycle: (evt: AutoFixCycleEvent) => {
            // Map auto-fix events to frontend-friendly progress messages
            const progressMap: Record<string, { phase: string; message: string }> = {
              architect_started: { phase: 'thinking', message: 'Architect agent designing file plan...' },
              architect_completed: { phase: 'thinking', message: 'Architecture plan ready — starting code generation...' },
              cycle_start: { phase: 'generating_code', message: `Cycle ${(evt as { cycle?: number }).cycle ?? 1}: Generating production code...` },
              actions_parsed: { phase: 'generating_code', message: `Code generated — parsing files...` },
              gate_run: { phase: 'quality_gate', message: `Running 49 quality checks...` },
              npm_check: { phase: 'quality_gate', message: `Validating npm dependencies...` },
              security_scan: { phase: 'security_scan', message: `Security scanner: checking 15 vulnerability categories...` },
              verifier_run: { phase: 'verifying', message: `Verifier agent: checking for AI slop and broken imports...` },
              test_suite_generated: { phase: 'testing', message: `Auto-generating test suite...` },
              testing_run: { phase: 'testing', message: `Running tests against generated code...` },
              reviewer_run: { phase: 'verifying', message: `Reviewer agent: final quality check...` },
              cycle_complete: { phase: 'generating_code', message: (evt as { passed?: boolean }).passed ? 'All checks passed!' : `Cycle failed — re-planning and trying again...` },
            };
            const mapped = progressMap[evt.kind];
            if (mapped) {
              broadcastToOwner(session.userId, {
                type: 'deploy_progress',
                operationId: op.id,
                evt: { phase: mapped.phase as 'thinking', message: mapped.message },
              });
            }
            broadcastToOwner(session.userId, { type: 'deploy_progress', operationId: op.id, evt });
          },
        });
        bundle = result.bundle;
        aiCycles = result.cycles;
        if (!result.success || !bundle) {
          await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
          return reply.code(422).send({
            error: 'autofix_exhausted',
            cycles: result.cycles,
            issues: result.finalReport.issues.slice(0, 25),
          });
        }
      } catch (err) {
        await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
        logger.error({ err }, 'autofix loop crashed');
        return reply.code(500).send({ error: 'autofix_crash', detail: String(err).slice(0, 400) });
      }
    } else if (mapDoc) {
      // ── Deterministic path (legacy): WorkflowMap → fixed templates ─────
      const map = mapDoc.map as WorkflowMap;
      const generated = generateBundle({
        operationId: op.id,
        operationSlug: op.slug,
        bundleVersion,
        workflowMapVersion: op.workflowMapVersion,
        generatedByModel,
        map,
      });
      if (!generated.ok) {
        await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
        return reply.code(500).send({ error: 'generation_failed', issues: generated.issues });
      }
      bundle = generated.bundle;
    }

    if (!bundle) {
      await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
      return reply.code(500).send({ error: 'no_bundle' });
    }

    // Final quality gate (defence in depth — auto-fix loop already did one,
    // but we re-run here so the deterministic path is also gated).
    const gateReport = runQualityGate(bundle);
    if (!gateReport.passed) {
      await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
      return reply.code(422).send({
        error: 'quality_gate_failed',
        issues: gateReport.issues.slice(0, 25),
      });
    }

    // Persist the FULL bundle (file contents included) so the repair worker
    // can fetch failing files when it needs to propose a patch. PII-safe by
    // construction — bundles are deterministic generator output, no PII.
    await db.collection('operation_bundles').insertOne({
      operationId: op.id,
      version: bundleVersion,
      manifest: bundle.manifest,
      files: bundle.files.map((f) => ({
        path: f.path,
        contents: f.contents,
        sha256: f.sha256,
        argoGenerated: f.argoGenerated,
        sourceStepId: f.sourceStepId,
        size: f.contents.length,
      })),
      filesSummary: bundle.files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        argoGenerated: f.argoGenerated,
        size: f.contents.length,
      })),
      generatedByModel,
      aiCycles,
      // Audit trail: security scan + test suite summary.
      securityScan: (() => {
        try { const r = runSecurityScan(bundle); return { passed: r.passed, riskScore: r.riskScore, counts: r.counts, findingCount: r.findings.length }; } catch { return null; }
      })(),
      testSuiteSummary: (() => {
        try { const s = generateTestSuiteForBundle(bundle); return s.summary; } catch { return null; }
      })(),
      createdAt: new Date().toISOString(),
    });

    // ── TESTING ────────────────────────────────────────────────────────
    await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'testing' } });
    broadcastToOwner(session.userId, { type: 'operation_status', operationId: op.id, status: 'testing' });

    // Generate the synthetic-submission suite from the legacy WorkflowMap
    // when it's present; otherwise the AI path's bundle is its own test
    // (the build agent emits the test cases inline).
    if (mapDoc && !briefDoc) {
      const cases = generateTestSuite(mapDoc.map as WorkflowMap);
      const testReport = await buildSandbox.runTests({ bundle, cases });
      if (!testReport.passed) {
        await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
        logger.warn({ operationId: op.id, testReport }, 'tests failed pre-deploy');
        return reply.code(409).send({ error: 'tests_failed', testReport });
      }
    }

    // ── DEPLOY ─────────────────────────────────────────────────────────
    await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'deploying' } });
    broadcastToOwner(session.userId, { type: 'operation_status', operationId: op.id, status: 'deploying' });

    // Load user-defined env vars and merge them (user vars take precedence
    // over system defaults so operators can override connection strings etc.).
    const userEnv = await loadEnvOverrides(op.id, session.userId);

    let handle;
    try {
      handle = await executionProvider.deploy({
        operationId: op.id,
        bundle,
        environment: 'production',
        envOverrides: {
          ARGO_CONTROL_PLANE_URL: process.env.API_PUBLIC_URL ?? 'http://host.docker.internal:4000',
          INTERNAL_API_KEY: process.env.INTERNAL_API_KEY ?? '',
          MONGODB_URI: process.env.MONGODB_URI ?? '',
          MONGODB_DB: `argo_op_${op.id}`,
          ...userEnv,
        },
        onProgress: (evt) => {
          broadcastToOwner(session.userId, { type: 'deploy_progress', operationId: op.id, evt });
        },
      });
    } catch (err) {
      await getPrisma().operation.update({ where: { id: op.id }, data: { status: 'failed_build' } });
      return reply.code(502).send({ error: 'deploy_failed', detail: String(err).slice(0, 400) });
    }

    await getPrisma().operation.update({
      where: { id: op.id },
      data: {
        status: 'running',
        publicUrl: handle.publicUrl,
        bundleVersion,
        deploymentProvider: handle.provider,
        deploymentSandboxId: handle.sandboxId,
        deploymentRegion: handle.region,
        lastEventAt: new Date(),
      },
    });

    // ── BUILD MANIFEST ──────────────────────────────────────────────
    // Every successful deploy ships an intensive doc cataloguing every
    // file / dep / agent / workflow / route. The catalogue is built
    // deterministically from the bundle; the prose sections are GPT-4o
    // (classifier-tier model — cheap, structured). Persisted in the
    // operation_manifests collection keyed on (operationId, bundleVersion).
    try {
      const manifestData = buildManifest({
        files: bundle.files.map((f) => ({
          path: f.path,
          contents: f.contents,
          argoGenerated: f.argoGenerated,
        })),
      });
      let prose = null;
      if (briefDoc) {
        const briefShape = briefDoc as unknown as ProjectBrief;
        try {
          prose = await composeManifestProse({
            operationName: op.name,
            brief: {
              name: briefShape.name,
              audience: briefShape.audience,
              outcome: briefShape.outcome,
              trigger: briefShape.trigger,
            },
            manifest: manifestData,
          });
        } catch (err) {
          // Prose is best-effort — manifest still ships without it.
          logger.warn({ err }, 'manifest prose generation failed; using deterministic boilerplate');
        }
      }
      const markdown = renderManifestAsMarkdown({
        operationName: op.name,
        bundleVersion,
        manifest: manifestData,
        ...(prose ? { prose } : {}),
      });
      await db.collection('operation_manifests').updateOne(
        { operationId: op.id, bundleVersion },
        {
          $set: {
            operationId: op.id,
            ownerId: session.userId,
            bundleVersion,
            manifest: manifestData,
            ...(prose ? { prose } : {}),
            markdown,
            generatedAt: new Date().toISOString(),
          },
        },
        { upsert: true },
      );
    } catch (err) {
      // Manifest never blocks a deploy.
      logger.warn({ err, operationId: op.id }, 'build manifest generation failed');
    }

    const activity = await appendActivity({
      ownerId: session.userId,
      operationId: op.id,
      operationName: op.name,
      kind: 'deployed',
      message: briefDoc
        ? `Shipped v${bundleVersion} via GPT-5.5 (${aiCycles} ${aiCycles === 1 ? 'cycle' : 'cycles'}) — live at ${handle.publicUrl}.`
        : `Deployed v${bundleVersion} — live at ${handle.publicUrl}.`,
    });
    broadcastToOwner(session.userId, { type: 'activity', payload: activity });
    broadcastToOwner(session.userId, { type: 'operation_status', operationId: op.id, status: 'running' });

    dispatchWebhook(op.id, 'deploy.completed', {
      operationId: op.id,
      bundleVersion,
      publicUrl: handle.publicUrl,
      model: generatedByModel,
    }).catch(() => undefined);

    return reply.send({
      ok: true,
      operationId: op.id,
      bundleVersion,
      publicUrl: handle.publicUrl,
      generatedByModel,
      aiCycles,
      handle,
    });
  });
}
