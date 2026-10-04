import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { EmailProvider } from '../../providers/notifications/channels';

export type TransactionalEmailKind =
  | 'FEE_RECEIPT'
  | 'ACCOUNT_DELETION'
  | 'PARTNER_APPROVED'
  | 'PARTNER_REJECTED'
  | 'DATA_EXPORT_READY';

type EmailTemplateInput = {
  kind: TransactionalEmailKind;
  receiptNumber?: string;
  amount?: number;
  currencyCode?: string;
  detail?: string;
};

export function emailOutboxDedupeKey(kind: TransactionalEmailKind, eventId: string): string {
  return `email:${kind}:${eventId}`;
}

function stableId(dedupeKey: string): string {
  return `email_${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}`;
}

export function renderTransactionalEmail(input: EmailTemplateInput): { subject: string; body: string } {
  switch (input.kind) {
    case 'FEE_RECEIPT':
      return {
        subject: 'Swift payment confirmation',
        body: `We received your payment of ${input.amount?.toLocaleString() ?? ''} ${input.currencyCode ?? ''}. Your receipt number is ${input.receiptNumber ?? ''}. Keep this email for your records.`,
      };
    case 'ACCOUNT_DELETION':
      return { subject: 'Your Swift account is closed', body: 'Your Swift account has been closed. Some records may be kept where the law requires it.' };
    case 'PARTNER_APPROVED':
      return { subject: 'Your Swift partner application was approved', body: 'Your submitted document was approved. You can return to Swift to continue setting up your business.' };
    case 'PARTNER_REJECTED':
      return { subject: 'Your Swift partner application needs an update', body: `Your submitted document was not approved${input.detail ? `: ${input.detail}` : ''}. Please update it in Swift and submit it again.` };
    case 'DATA_EXPORT_READY':
      return { subject: 'Your Swift data export is ready', body: 'Your requested data export is ready in Swift. Sign in to download your copy.' };
  }
}

export async function queueTransactionalEmailInTransaction(
  tx: PrismaClient | Prisma.TransactionClient,
  input: { kind: TransactionalEmailKind; eventId: string; userId: string; recipient: string; template: EmailTemplateInput; now?: Date },
): Promise<string> {
  const dedupeKey = emailOutboxDedupeKey(input.kind, input.eventId);
  const message = renderTransactionalEmail(input.template);
  const id = stableId(dedupeKey);
  await tx.emailOutbox.createMany({
    data: [{ id, dedupeKey, userId: input.userId, kind: input.kind, recipient: input.recipient, subject: message.subject, body: message.body, availableAt: input.now ?? new Date() }],
    skipDuplicates: true,
  });
  return id;
}

const CLAIM_LEASE_MS = 60_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
/** Eight attempts span about 15 minutes with the capped exponential backoff.
 * The final failure is terminal and paged; a poison address must never own a
 * worker slot indefinitely. */
export const EMAIL_OUTBOX_MAX_ATTEMPTS = 8;
const LONG_PENDING_MS = 24 * 60 * 60 * 1000;
const REDACTED = '[redacted]';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'email delivery failed';
}

function appendErrorHistory(previous: Prisma.JsonValue, next: string): string[] {
  const history = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === 'string') : [];
  return [...history.slice(-(EMAIL_OUTBOX_MAX_ATTEMPTS - 1)), next];
}

/** Cancels every previously-unsent obligation before an account is
 * de-identified. The caller creates the separate account-closure confirmation
 * after this operation, so that one final message remains deliberate. */
export async function cancelPendingEmailOutboxForUser(
  tx: PrismaClient | Prisma.TransactionClient,
  userId: string,
  now = new Date(),
): Promise<number> {
  const cancelled = await tx.emailOutbox.updateMany({
    where: { userId, processedAt: null, failedAt: null, cancelledAt: null },
    data: {
      cancelledAt: now,
      claimedAt: null,
      claimToken: null,
      recipient: REDACTED,
      subject: REDACTED,
      body: REDACTED,
      lastError: 'cancelled at account deletion before delivery',
    },
  });
  return cancelled.count;
}

export async function emailOutboxHealth(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ parked: number; longPending: number }> {
  const [parked, longPending] = await Promise.all([
    prisma.emailOutbox.count({ where: { failedAt: { not: null } } }),
    prisma.emailOutbox.count({
      where: {
        processedAt: null,
        failedAt: null,
        cancelledAt: null,
        createdAt: { lte: new Date(now.getTime() - LONG_PENDING_MS) },
      },
    }),
  ]);
  return { parked, longPending };
}

export async function drainEmailOutbox(
  prisma: PrismaClient,
  email: EmailProvider,
  now = new Date(),
): Promise<number> {
  const candidates = await prisma.emailOutbox.findMany({
    where: { processedAt: null, failedAt: null, cancelledAt: null, availableAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }] },
    orderBy: { createdAt: 'asc' },
    take: 25,
    select: { id: true },
  });
  let delivered = 0;
  for (const candidate of candidates) {
    const claimToken = randomUUID();
    const claimed = await prisma.emailOutbox.updateMany({
      where: { id: candidate.id, processedAt: null, failedAt: null, cancelledAt: null, availableAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }] },
      data: { claimedAt: now, claimToken },
    });
    if (claimed.count !== 1) continue;
    const row = await prisma.emailOutbox.findFirst({ where: { id: candidate.id, claimToken, processedAt: null, failedAt: null, cancelledAt: null } });
    if (!row) continue;
    try {
      await email.sendEmail(row.recipient, row.subject, row.body);
      const completed = await prisma.emailOutbox.updateMany({ where: { id: row.id, claimToken, processedAt: null }, data: { processedAt: new Date(), claimToken: null } });
      delivered += completed.count;
    } catch (error) {
      const message = errorMessage(error);
      const attempts = row.attempts + 1;
      const parked = attempts >= EMAIL_OUTBOX_MAX_ATTEMPTS;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(row.attempts, 8)));
      await prisma.emailOutbox.updateMany({
        where: { id: row.id, claimToken, processedAt: null, failedAt: null, cancelledAt: null },
        data: {
          attempts,
          availableAt: parked ? now : new Date(now.getTime() + delay),
          claimedAt: null,
          claimToken: null,
          failedAt: parked ? now : null,
          lastError: message,
          lastErrorHistory: appendErrorHistory(row.lastErrorHistory, message),
        },
      });
    }
  }
  return delivered;
}
