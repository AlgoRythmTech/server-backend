// Renders a ProjectBrief into the user prompt the auto-fix build loop sees.
// Deterministic, dense, ordered. The whole reason we collected the brief
// is so this prompt is precise — no ambiguity for GPT-5.5 to fill in
// creatively.

import type { ProjectBrief } from '@argo/shared-types';

const INTEGRATION_DESCRIPTIONS: Record<ProjectBrief['integrations'][number], string> = {
  slack: 'Slack — POST chat messages via @slack/bolt. Sign requests with SLACK_SIGNING_SECRET.',
  discord: 'Discord — Discord.js bot framework, gateway events.',
  gmail: 'Gmail — receive and send via the user-supplied Gmail API credentials.',
  calendly: 'Calendly — link generation + webhook receiver for booking events.',
  stripe: 'Stripe — checkout sessions, webhooks for payment.intent.succeeded.',
  mongodb: 'MongoDB — primary persistence, use the official mongodb driver.',
  postgres: 'Postgres — primary persistence, use pg with pooled connections.',
  sendgrid: 'NOT in the allow-list. Use AgentMail instead.',
  twilio: 'Twilio — SMS via the official twilio SDK.',
  openai: 'OpenAI — call from server-side only with OPENAI_API_KEY.',
  anthropic: 'Anthropic — Claude via the @anthropic-ai/sdk.',
  s3: 'S3 — @aws-sdk/client-s3 (allow-list addition required).',
  webhooks_inbound: 'Inbound webhooks — HMAC-SHA256 signature verification mandatory.',
  webhooks_outbound: 'Outbound webhooks — sign with HMAC + Argo timestamp + 5-min replay window.',
};

export function renderBriefAsPrompt(brief: ProjectBrief): string {
  const lines: string[] = [];
  lines.push(`# Build brief — generate a complete production runtime for "${brief.name}"`);
  lines.push('');
  lines.push('You have a precise, fully-scoped specification below. Build to it exactly.');
  lines.push('Do not invent features the brief does not request. Do not skip features it does.');
  lines.push('');

  lines.push('## Identity');
  lines.push(`- **Name**: ${brief.name}`);
  lines.push(`- **Audience**: ${brief.audience}`);
  lines.push(`- **Outcome**: ${brief.outcome}`);
  lines.push('');

  lines.push('## Trigger');
  lines.push(`- ${brief.trigger}`);
  if (brief.trigger === 'form_submission' && (brief.fields?.length ?? 0) > 0) {
    lines.push('');
    lines.push('## Form fields (the public form ingests these — generate Zod + HTML for each)');
    for (const f of brief.fields) {
      const opts = f.options.length > 0 ? `, options=${JSON.stringify(f.options)}` : '';
      lines.push(`- ${f.id}: ${f.label} — type=${f.type}, required=${f.required}${opts}`);
    }
  }
  lines.push('');

  lines.push('## Persistence');
  lines.push(`- Primary store: ${brief.persistence}`);
  lines.push('');

  lines.push('## Auth (for the operator\'s end-users — not Argo)');
  lines.push(`- ${brief.auth}`);
  lines.push('');

  if ((brief.integrations?.length ?? 0) > 0) {
    lines.push('## Integrations to wire');
    for (const i of brief.integrations) {
      lines.push(`- **${i}** — ${INTEGRATION_DESCRIPTIONS[i] ?? '(no canonical pattern; pick the obvious choice)'}`);
    }
    lines.push('');
  }

  lines.push('## Rate limits (fastify @fastify/rate-limit)');
  lines.push(`- Forms: ${brief.rateLimits?.formPerMinutePerIp ?? 60} req/min/IP`);
  lines.push(`- Webhooks: ${brief.rateLimits?.webhookPerMinutePerIp ?? 1000} req/min/IP`);
  lines.push('');

  lines.push('## Data classification');
  lines.push(`- ${brief.dataClassification}`);
  if (brief.dataClassification === 'pii' || brief.dataClassification === 'pii_with_kyc') {
    lines.push('- Apply redactPii() before any log line that touches a payload field.');
  }
  lines.push('');

  if (brief.successCriteria.length > 0) {
    lines.push('## Success criteria (every submission is scored against these)');
    for (const c of brief.successCriteria) lines.push(`- ${c}`);
    lines.push('');
  }

  lines.push('## Reply tone & voice');
  lines.push(`- Style: ${brief.replyStyle}`);
  if (brief.voiceTone) lines.push(`- Voice notes: ${brief.voiceTone}`);
  lines.push('');

  lines.push('## Scheduling');
  lines.push(
    `- Weekly digest: ${brief.scheduling?.digestEnabled ? 'enabled' : 'disabled'} ` +
      `(cron "${brief.scheduling?.digestCron ?? '0 9 * * 1'}", tz "${brief.scheduling?.digestTimezone ?? 'America/New_York'}")`,
  );
  lines.push('');

  if ((brief.notificationRecipients?.length ?? 0) > 0) {
    lines.push('## Notification recipients (operator + their cohort)');
    for (const r of brief.notificationRecipients) lines.push(`- ${r}`);
    lines.push('');
  }

  if (brief.complianceNotes) {
    lines.push('## Compliance notes');
    lines.push(brief.complianceNotes);
    lines.push('');
  }

  if (brief.freeForm) {
    lines.push('## Additional context from the operator');
    lines.push(brief.freeForm);
    lines.push('');
  }

  if ((brief.defaulted?.length ?? 0) > 0) {
    lines.push('## Argo-defaulted fields (operator did NOT pick these — use sensible defaults)');
    for (const d of brief.defaulted) lines.push(`- ${d}`);
    lines.push('');
  }

  lines.push('## Build deliverable');
  lines.push('- A complete deterministic runtime that boots cleanly inside Blaxel.');
  lines.push('- Every public route Zod-validated.');
  lines.push('- Every outbound email through @argo/email-automation with escapeForEmail().');
  lines.push('- /health route registered first, binds 0.0.0.0, SIGTERM handler.');
  lines.push('- Observability sidecar wired so the repair worker sees runtime errors.');
  lines.push('- argo:generated header on every generated file.');
  lines.push('- Imports allow-listed only.');
  lines.push('- One <dyad-write> per file. One <dyad-chat-summary> at the end.');

  return lines.join('\n');
}
