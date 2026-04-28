import { Worker } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { getPrisma } from '../db/prisma.js';
import { getMongo } from '../db/mongo.js';
import { composeWeeklyDigest, DefaultLlmRouter } from '@argo/agent';
import { createEmailAutomationService, renderDigestEmail, toOutboundEmail } from '@argo/email-automation';
import { MongoInvocationStore } from '../stores/invocation-store.js';
import { logger } from '../logger.js';
import { nanoid } from 'nanoid';
import { appendActivity } from '../stores/activity-store.js';
import { broadcastToOwner } from '../realtime/socket.js';

const router = DefaultLlmRouter.fromEnv();
const store = new MongoInvocationStore();
const email = createEmailAutomationService();

export function startDigestWorker() {
  return new Worker(
    'argo-digest',
    async (job) => {
      const { operationId } = job.data as { operationId: string };
      const op = await getPrisma().operation.findUnique({ where: { id: operationId } });
      if (!op) {
        logger.warn({ operationId }, 'digest worker: op not found');
        return;
      }

      const { db } = await getMongo();
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const sinceLast = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      const submissionsThisWeek = await db
        .collection('submissions')
        .countDocuments({ operationId: op.id, receivedAt: { $gte: since.toISOString() } });
      const submissionsLastWeek = await db.collection('submissions').countDocuments({
        operationId: op.id,
        receivedAt: { $gte: sinceLast.toISOString(), $lt: since.toISOString() },
      });

      const approvedThisWeek = await getPrisma().approval.count({
        where: { operationId: op.id, status: 'approved', decidedAt: { gte: since } },
      });
      const declinedThisWeek = await getPrisma().approval.count({
        where: { operationId: op.id, status: 'declined', decidedAt: { gte: since } },
      });
      const pendingApprovals = await getPrisma().approval.count({
        where: { operationId: op.id, status: 'pending' },
      });

      const owner = await getPrisma().user.findUnique({ where: { id: op.ownerId } });
      const firstName = owner?.name?.split(' ')[0] ?? owner?.email.split('@')[0] ?? 'there';

      const result = await composeWeeklyDigest(router, store, {
        operationId: op.id,
        ownerId: op.ownerId,
        operationName: op.name,
        triggerKind: 'form_submission',
        audience: 'workflow audience',
        outcome: 'workflow outcome',
        weekSummary: {
          submissionsThisWeek,
          submissionsLastWeek,
          approvedThisWeek,
          declinedThisWeek,
          pendingApprovals,
          anomalies: [],
          stalledItems: [],
        },
        voiceCorpus: [],
      });

      if (!result.ok) {
        logger.warn({ operationId: op.id, reason: result.reason }, 'digest composition failed');
        return;
      }

      const rendered = renderDigestEmail({
        operationName: op.name,
        ownerFirstName: firstName,
        paragraphs: [result.data.paragraphOne, result.data.paragraphTwo, result.data.paragraphThree],
        ...(result.data.proposedActionLabel && result.data.proposedActionDescription
          ? {
              proposedActionLabel: result.data.proposedActionLabel,
              proposedActionUrl: `${process.env.API_PUBLIC_URL}/api/operations/${op.id}/proposed-action`,
            }
          : {}),
      });

      const outbound = toOutboundEmail({
        id: 'eml_' + nanoid(12),
        operationId: op.id,
        kind: 'digest_to_owner',
        from: { name: 'Argo', email: process.env.AGENTMAIL_FROM_ADDRESS ?? 'argoai@agentmail.to' },
        to: [{ email: owner?.email ?? op.id }],
        rendered,
      });
      await email.send(outbound);

      const a = await appendActivity({
        ownerId: op.ownerId,
        operationId: op.id,
        operationName: op.name,
        kind: 'digest_sent',
        message: 'Weekly digest sent.',
      });
      broadcastToOwner(op.ownerId, { type: 'activity', payload: a });
    },
    { connection: getRedis(), concurrency: 4 },
  );
}
