import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  drainEmailOutbox,
  emailOutboxDedupeKey,
  queueTransactionalEmailInTransaction,
  renderTransactionalEmail,
} from '../modules/notification/email-outbox';

const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.emailOutbox.deleteMany({ where: { dedupeKey: { startsWith: 'email:' } } });
});

afterAll(async () => {
  await prisma.emailOutbox.deleteMany({ where: { dedupeKey: { startsWith: 'email:' } } });
  await prisma.$disconnect();
});

describe('transactional email outbox', () => {
  it('uses one stable key per recipient-owned event and renders plain-language copy', () => {
    expect(emailOutboxDedupeKey('FEE_RECEIPT', 'receipt-1')).toBe('email:FEE_RECEIPT:receipt-1');
    expect(renderTransactionalEmail({
      kind: 'FEE_RECEIPT',
      receiptNumber: 'SWF-SWIFT-2026-000001',
      amount: 8000,
      currencyCode: 'GYD',
    })).toEqual({
      subject: 'Swift payment confirmation',
      body: expect.stringContaining('SWF-SWIFT-2026-000001'),
    });
  });

  it('commits one receipt email, sends it once, and records the provider result', async () => {
    await prisma.$transaction(async (tx) => {
      await queueTransactionalEmailInTransaction(tx, {
        kind: 'FEE_RECEIPT', eventId: 'receipt-1', recipient: 'partner@example.test',
        template: { kind: 'FEE_RECEIPT', receiptNumber: 'SWF-SWIFT-2026-000001', amount: 8000, currencyCode: 'GYD' },
      });
      await queueTransactionalEmailInTransaction(tx, {
        kind: 'FEE_RECEIPT', eventId: 'receipt-1', recipient: 'partner@example.test',
        template: { kind: 'FEE_RECEIPT', receiptNumber: 'SWF-SWIFT-2026-000001', amount: 8000, currencyCode: 'GYD' },
      });
    });
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    await expect(drainEmailOutbox(prisma, { sendEmail: async (to, subject, body) => {
      sent.push({ to, subject, body }); return { ref: 'capture-1' };
    } })).resolves.toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('partner@example.test');
    await expect(drainEmailOutbox(prisma, { sendEmail: async () => ({ ref: 'unexpected' }) })).resolves.toBe(0);
    await expect(prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:FEE_RECEIPT:receipt-1' } })).resolves.toMatchObject({ processedAt: expect.any(Date), attempts: 0 });
  });

  it('keeps a failed email owed with an exponential retry time', async () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    await prisma.$transaction((tx) => queueTransactionalEmailInTransaction(tx, {
      kind: 'DATA_EXPORT_READY', eventId: 'export-1', recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' }, now,
    }));
    await expect(drainEmailOutbox(prisma, { sendEmail: async () => { throw new Error('capture unavailable'); } }, now)).resolves.toBe(0);
    const pending = await prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:export-1' } });
    expect(pending).toMatchObject({ attempts: 1, processedAt: null, claimedAt: null, claimToken: null, lastError: 'capture unavailable' });
    expect(pending.availableAt).toEqual(new Date(now.getTime() + 2_000));
  });
});
