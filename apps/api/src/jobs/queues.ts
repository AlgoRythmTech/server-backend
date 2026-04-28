import { Queue } from 'bullmq';
import { getRedis } from '../db/redis.js';

let digestQueue: Queue | null = null;
let inboundQueue: Queue | null = null;
let reminderQueue: Queue | null = null;
let repairQueue: Queue | null = null;
let approvalEmailQueue: Queue | null = null;

const opts = () => ({ connection: getRedis() });

export function getDigestQueue(): Queue {
  if (!digestQueue) digestQueue = new Queue('argo-digest', opts());
  return digestQueue;
}
export function getInboundQueue(): Queue {
  if (!inboundQueue) inboundQueue = new Queue('argo-inbound', opts());
  return inboundQueue;
}
export function getReminderQueue(): Queue {
  if (!reminderQueue) reminderQueue = new Queue('argo-reminder', opts());
  return reminderQueue;
}
export function getRepairQueue(): Queue {
  if (!repairQueue) repairQueue = new Queue('argo-repair', opts());
  return repairQueue;
}
export function getApprovalEmailQueue(): Queue {
  if (!approvalEmailQueue) approvalEmailQueue = new Queue('argo-approval-email', opts());
  return approvalEmailQueue;
}
