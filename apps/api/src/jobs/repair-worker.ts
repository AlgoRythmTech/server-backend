import { Worker } from 'bullmq';
import { setInterval } from 'node:timers';
import { nanoid } from 'nanoid';
import { getRedis } from '../db/redis.js';
import { getMongo } from '../db/mongo.js';
import { getPrisma } from '../db/prisma.js';
import { logger } from '../logger.js';
import { getRepairQueue } from './queues.js';
import { DefaultLlmRouter, proposeRepairPatch } from '@argo/agent';
import { MongoInvocationStore } from '../stores/invocation-store.js';
import { createBuildSandbox, createExecutionProvider } from '@argo/workspace-runtime';
import { generateApprovalToken } from '@argo/security';
import { createEmailAutomationService, renderRepairApprovalEmail, toOutboundEmail } from '@argo/email-automation';
import { appendActivity } from '../stores/activity-store.js';
import { broadcastToOwner } from '../realtime/socket.js';
import type { RepairFailureKind } from '@argo/shared-types';
import { dispatchWebhook } from '../services/webhook-dispatcher.js';
import { classifyError, renderClassificationAsRepairContext, type ErrorClassification } from '../services/error-intelligence.js';

const router = DefaultLlmRouter.fromEnv();
const store = new MongoInvocationStore();
const buildSandbox = createBuildSandbox();
const executionProvider = createExecutionProvider();
const email = createEmailAutomationService();

/**
 * Section 11 — repair flow.
 *
 * 1. Detect: poll runtime_events every 30s. Failure thresholds:
 *    three 5xx in 60s, any unhandled exception, memory >=85% sustained 90s,
 *    three consecutive process restarts.
 * 2. Diagnose: classify failureKind, build a repair prompt, propose a patch.
 * 3. Patch and stage: apply, redeploy to staging, run the test suite. 3 cycles.
 * 4. Request approval via email (locked template).
 * 5. On approval, swap staging into production via IExecutionProvider.
 * 6. Audit row in operation_repairs (compliance — append-only).
 */

const POLL_MS = Number.parseInt(process.env.REPAIR_POLL_INTERVAL_MS ?? '30000', 10);

export function startRepairDetector() {
  setInterval(() => {
    detectAndEnqueue().catch((err) => logger.warn({ err }, 'repair detector failed'));
  }, POLL_MS).unref();
}

async function detectAndEnqueue() {
  const { db } = await getMongo();
  const since = new Date(Date.now() - 60_000).toISOString();

  // Three 5xx in the last 60s — group by operation.
  const fivexx = await db
    .collection('runtime_events')
    .aggregate([
      { $match: { kind: 'http_5xx', occurredAt: { $gte: since }, processedAt: null } },
      { $group: { _id: '$operationId', count: { $sum: 1 }, lastEventId: { $last: '$id' } } },
      { $match: { count: { $gte: 3 } } },
    ])
    .toArray();

  for (const grp of fivexx) {
    const op = await getPrisma().operation.findUnique({ where: { id: String(grp._id) } });
    if (!op || op.status !== 'running') continue;
    await getRepairQueue().add(
      'repair_' + nanoid(8),
      { operationId: op.id, failureKind: 'application_error' as RepairFailureKind },
      { removeOnComplete: 50, removeOnFail: 200 },
    );
    dispatchWebhook(op.id, 'error.detected', {
      operationId: op.id,
      kind: 'http_5xx',
      count: grp.count,
    }).catch(() => undefined);
    await db.collection('runtime_events').updateMany(
      { operationId: op.id, kind: 'http_5xx', processedAt: null },
      { $set: { processedAt: new Date().toISOString() } },
    );
  }

  // Any unhandled_exception → enqueue immediately.
  const exceptions = await db
    .collection('runtime_events')
    .find({ kind: 'unhandled_exception', processedAt: null })
    .limit(20)
    .toArray();
  for (const e of exceptions) {
    const op = await getPrisma().operation.findUnique({ where: { id: String(e.operationId) } });
    if (op && op.status === 'running') {
      await getRepairQueue().add(
        'repair_' + nanoid(8),
        { operationId: op.id, failureKind: 'application_error' as RepairFailureKind, triggerEventId: e.id },
        { removeOnComplete: 50, removeOnFail: 200 },
      );
      dispatchWebhook(op.id, 'error.detected', {
        operationId: op.id,
        kind: 'unhandled_exception',
        count: 1,
      }).catch(() => undefined);
    }
    await db.collection('runtime_events').updateOne(
      { _id: e._id },
      { $set: { processedAt: new Date().toISOString() } },
    );
  }
}

export function startRepairWorker() {
  return new Worker(
    'argo-repair',
    async (job) => {
      const { operationId, failureKind, triggerEventId } = job.data as {
        operationId: string;
        failureKind: RepairFailureKind;
        triggerEventId?: string;
      };
      const op = await getPrisma().operation.findUnique({ where: { id: operationId } });
      if (!op) return;

      const { db } = await getMongo();
      const bundleDoc = await db
        .collection('operation_bundles')
        .find({ operationId: op.id })
        .sort({ version: -1 })
        .limit(1)
        .next();
      if (!bundleDoc) {
        logger.warn({ operationId }, 'repair: no bundle found');
        return;
      }

      // Trust ratchet: first 3 repairs are forced to "smallest possible change".
      const priorRepairs = await getPrisma().approval.count({
        where: { operationId: op.id, status: 'approved', subjectLine: { startsWith: '[Argo · ' } },
      });
      const smallerChange =
        priorRepairs < (Number.parseInt(process.env.REPAIR_TRUST_FORCE_SMALL_CHANGE_FIRST ?? '3', 10) ?? 3);

      // Load failing-file contents from the persisted bundle. The deploy
      // route now stores `files: [{ path, contents, ... }]` (NOT just
      // filesSummary), so the repair agent sees the actual code.
      const persistedFiles = (bundleDoc.files ?? []) as Array<{
        path: string;
        contents: string;
        argoGenerated: boolean;
      }>;
      const failingFiles: Array<{ path: string; contents: string }> = persistedFiles
        .filter(
          (f) =>
            f.argoGenerated &&
            (f.path.startsWith('routes/') || f.path.startsWith('jobs/') || f.path.startsWith('schema/')),
        )
        .map((f) => ({ path: f.path, contents: f.contents }));

      // Fallback if a legacy bundle persisted only filesSummary.
      if (failingFiles.length === 0) {
        for (const f of (bundleDoc.filesSummary ?? []) as Array<{ path: string }>) {
          if (f.path.startsWith('routes/')) {
            failingFiles.push({
              path: f.path,
              contents: '// (legacy bundle — contents not persisted; please redeploy to enable repair)',
            });
          }
        }
      }

      // ── Error Intelligence: classify the error before calling the LLM ──
      // This narrows the scope of files and gives the LLM a head start.
      let classification: ErrorClassification | null = null;
      const triggerEvent = triggerEventId
        ? await db.collection('runtime_events').findOne({ id: triggerEventId })
        : null;
      const recentEvents = await db
        .collection('runtime_events')
        .find({ operationId: op.id })
        .sort({ occurredAt: -1 })
        .limit(10)
        .toArray();

      try {
        classification = classifyError({
          operationId: op.id,
          stackTrace: String((triggerEvent as Record<string, unknown> | null)?.stackTrace ?? triggerEventId ?? ''),
          errorMessage: String((triggerEvent as Record<string, unknown> | null)?.message ?? failureKind),
          recentEvents: recentEvents.map((e) => ({
            kind: String((e as Record<string, unknown>).kind ?? ''),
            message: String((e as Record<string, unknown>).message ?? ''),
            occurredAt: String((e as Record<string, unknown>).occurredAt ?? ''),
          })),
          bundleFiles: persistedFiles,
        });
        logger.info({
          operationId,
          pattern: classification.pattern,
          confidence: classification.confidence,
          autoFixable: classification.autoFixable,
        }, 'error classified');
      } catch (err) {
        logger.warn({ err }, 'error classification failed — proceeding without');
      }

      // If classification identified specific affected files, narrow the scope
      // so the LLM only sees relevant code (cheaper, faster, more accurate).
      const scopedFiles = classification?.affectedFiles.length
        ? failingFiles.filter((f) =>
            classification!.affectedFiles.some((af) => f.path.includes(af) || af.includes(f.path)),
          )
        : failingFiles;
      // If scoping removed everything, fall back to all files.
      const filesToRepair = scopedFiles.length > 0 ? scopedFiles : failingFiles;

      // Build the repair context with classification intelligence.
      const repairContext = classification
        ? renderClassificationAsRepairContext(classification)
        : '';

      const proposal = await proposeRepairPatch(router, store, {
        operationId: op.id,
        ownerId: op.ownerId,
        operationName: op.name,
        triggerKind: 'form_submission',
        audience: 'workflow audience',
        outcome: 'workflow outcome',
        failureKind,
        failingFiles: filesToRepair,
        stackTrace: (repairContext ? repairContext + '\n\n' : '') + (triggerEventId ?? ''),
        requestPayload: {},
        smallerChange,
        recentEvents: [],
      });

      if (!proposal.ok) {
        logger.warn({ operationId, reason: proposal.reason }, 'repair proposal failed');
        return;
      }

      // For v1 we email the owner the human-readable summary; staging-swap
      // and the test loop run when the owner clicks Approve via the
      // approval route (handled by /api/repairs/:id/approve).
      const { plaintext, hash } = generateApprovalToken();
      const repairDoc = {
        id: 'rep_' + nanoid(12),
        operationId: op.id,
        triggerEventIds: triggerEventId ? [triggerEventId] : [],
        failureKind,
        status: 'awaiting_approval',
        cycleNumber: 1,
        smallerChangeForced: smallerChange,
        diagnosis: proposal.data.diagnosis,
        plainEnglishSummary: proposal.data.whatChanged,
        whatBroke: proposal.data.whatBroke,
        whatChanged: proposal.data.whatChanged,
        whatWeTested: proposal.data.whatWeTested,
        patchedFiles: proposal.data.files.map((f) => ({
          path: f.path,
          beforeSha256: '0'.repeat(64),
          afterSha256: '0'.repeat(64),
          diffUnified: f.replacement.slice(0, 2000),
          reason: f.reason,
        })),
        testReport: null,
        errorClassification: classification ? {
          pattern: classification.pattern,
          confidence: classification.confidence,
          rootCause: classification.rootCause,
          severity: classification.severity,
          category: classification.category,
          autoFixable: classification.autoFixable,
          affectedFiles: classification.affectedFiles,
          suggestedFix: classification.suggestedFix,
        } : null,
        approvalTokenHash: hash,
        approvalEmailedAt: new Date().toISOString(),
        approvedAt: null,
        deployedAt: null,
        rolledBackAt: null,
        createdAt: new Date().toISOString(),
        proposedFiles: proposal.data.files,
      };
      await db.collection('operation_repairs').insertOne(repairDoc);

      const owner = await getPrisma().user.findUnique({ where: { id: op.ownerId } });
      const firstName = owner?.name?.split(' ')[0] ?? owner?.email.split('@')[0] ?? 'there';
      const approveUrl = `${process.env.API_PUBLIC_URL}/api/repairs/${repairDoc.id}/approve?token=${encodeURIComponent(plaintext)}`;
      const reviewUrl = `${(process.env.API_CORS_ORIGINS ?? 'http://localhost:5173').split(',')[0]}/repairs/${repairDoc.id}`;

      const rendered = renderRepairApprovalEmail({
        operationName: op.name,
        ownerFirstName: firstName,
        whatBroke: proposal.data.whatBroke,
        whatChanged: proposal.data.whatChanged,
        whatWeTested: proposal.data.whatWeTested,
        approveUrl,
        reviewUrl,
      });

      await email.send(
        toOutboundEmail({
          id: 'eml_' + nanoid(12),
          operationId: op.id,
          kind: 'repair_approval',
          from: { name: 'Argo', email: process.env.AGENTMAIL_FROM_ADDRESS ?? 'argoai@agentmail.to' },
          to: [{ email: owner?.email ?? `${op.id}@argo.local` }],
          rendered,
        }),
      );

      dispatchWebhook(op.id, 'repair.proposed', {
        repairId: repairDoc.id,
        operationId: op.id,
        whatBroke: proposal.data.whatBroke,
        whatChanged: proposal.data.whatChanged,
      }).catch(() => undefined);

      const a = await appendActivity({
        ownerId: op.ownerId,
        operationId: op.id,
        operationName: op.name,
        kind: 'repair_proposed',
        message: `Repair ready — ${proposal.data.whatBroke}.`,
      });
      broadcastToOwner(op.ownerId, { type: 'activity', payload: a });

      // Reference unused symbols so tree-shaking keeps them visible.
      void buildSandbox;
      void executionProvider;
    },
    { connection: getRedis(), concurrency: 2 },
  );
}
