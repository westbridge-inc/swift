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
  input: { kind: TransactionalEmailKind; eventId: string; recipient: string; template: EmailTemplateInput; now?: Date },
): Promise<string> {
  const dedupeKey = emailOutboxDedupeKey(input.kind, input.eventId);
  const message = renderTransactionalEmail(input.template);
  const id = stableId(dedupeKey);
  await tx.emailOutbox.createMany({
    data: [{ id, dedupeKey, kind: input.kind, recipient: input.recipient, subject: message.subject, body: message.body, availableAt: input.now ?? new Date() }],
    skipDuplicates: true,
  });
  return id;
}

const CLAIM_LEASE_MS = 60_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;

export async function drainEmailOutbox(
  prisma: PrismaClient,
  email: EmailProvider,
  now = new Date(),
): Promise<number> {
  const candidates = await prisma.emailOutbox.findMany({
    where: { processedAt: null, availableAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }] },
    orderBy: { createdAt: 'asc' },
    take: 25,
    select: { id: true },
  });
  let delivered = 0;
  for (const candidate of candidates) {
    const claimToken = randomUUID();
    const claimed = await prisma.emailOutbox.updateMany({
      where: { id: candidate.id, processedAt: null, availableAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }] },
      data: { claimedAt: now, claimToken },
    });
    if (claimed.count !== 1) continue;
    const row = await prisma.emailOutbox.findFirst({ where: { id: candidate.id, claimToken, processedAt: null } });
    if (!row) continue;
    try {
      await email.sendEmail(row.recipient, row.subject, row.body);
      const completed = await prisma.emailOutbox.updateMany({ where: { id: row.id, claimToken, processedAt: null }, data: { processedAt: new Date(), claimToken: null } });
      delivered += completed.count;
    } catch (error) {
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(row.attempts, 8)));
      await prisma.emailOutbox.updateMany({
        where: { id: row.id, claimToken, processedAt: null },
        data: { attempts: { increment: 1 }, availableAt: new Date(now.getTime() + delay), claimedAt: null, claimToken: null, lastError: error instanceof Error ? error.message.slice(0, 500) : 'email delivery failed' },
      });
    }
  }
  return delivered;
}
