import { Worker } from 'bullmq';
import { getRedis } from '../db/redis.js';
import { getMongo } from '../db/mongo.js';
import { logger } from '../logger.js';
import { hashToken } from '@argo/security';
import { getPrisma } from '../db/prisma.js';
import { broadcastToOwner } from '../realtime/socket.js';
import { appendActivity } from '../stores/activity-store.js';

/**
 * Inbound email worker. Routes the email to the right downstream:
 *   - approval token in routing hint → resolve approval
 *   - approval-style intent + selectors → batch approvals
 *   - free-text question → enqueue a digest-style answer (v2)
 */
export function startInboundWorker() {
  return new Worker(
    'argo-inbound',
    async (job) => {
      const { inboundEmailId } = job.data as { inboundEmailId: string };
      const { db } = await getMongo();
      const inbound = await db.collection('inbound_emails').findOne({ id: inboundEmailId });
      if (!inbound) {
        logger.warn({ inboundEmailId }, 'inbound worker: not found');
        return;
      }

      const hint = inbound.routingHint as { operationId?: string; approvalToken?: string } | undefined;
      if (hint?.approvalToken) {
        const tokenHash = hashToken(hint.approvalToken);
        const approval = await getPrisma().approval.findUnique({ where: { tokenHash } });
        if (approval && approval.status === 'pending') {
          await getPrisma().approval.update({
            where: { id: approval.id },
            data: { status: 'approved', decidedAt: new Date() },
          });
          const op = await getPrisma().operation.findUnique({ where: { id: approval.operationId } });
          if (op) {
            const a = await appendActivity({
              ownerId: op.ownerId,
              operationId: op.id,
              operationName: op.name,
              kind: 'approval_via_reply',
              message: 'Approval granted via email reply.',
            });
            broadcastToOwner(op.ownerId, { type: 'activity', payload: a });
          }
        }
      }

      // Other intent kinds — route to operations queue (v2). For now, just log.
      logger.info({ inboundEmailId, intentKind: (inbound.intent as { kind?: string } | undefined)?.kind }, 'inbound parsed');
    },
    { connection: getRedis(), concurrency: 4 },
  );
}
