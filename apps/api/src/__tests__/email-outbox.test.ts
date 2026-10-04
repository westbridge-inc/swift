import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  cancelPendingEmailOutboxForUser,
  drainEmailOutbox,
  emailOutboxDedupeKey,
  emailOutboxHealth,
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
        kind: 'FEE_RECEIPT', eventId: 'receipt-1', userId: 'email-outbox-subject', recipient: 'partner@example.test',
        template: { kind: 'FEE_RECEIPT', receiptNumber: 'SWF-SWIFT-2026-000001', amount: 8000, currencyCode: 'GYD' },
      });
      await queueTransactionalEmailInTransaction(tx, {
        kind: 'FEE_RECEIPT', eventId: 'receipt-1', userId: 'email-outbox-subject', recipient: 'partner@example.test',
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
      kind: 'DATA_EXPORT_READY', eventId: 'export-1', userId: 'email-outbox-subject', recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' }, now,
    }));
    await expect(drainEmailOutbox(prisma, { sendEmail: async () => { throw new Error('capture unavailable'); } }, now)).resolves.toBe(0);
    const pending = await prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:export-1' } });
    expect(pending).toMatchObject({ attempts: 1, processedAt: null, claimedAt: null, claimToken: null, lastError: 'capture unavailable' });
    expect(pending.availableAt).toEqual(new Date(now.getTime() + 2_000));
  });

  it('parks a permanent provider failure after the bounded attempt budget and retains its error history', async () => {
    let now = new Date('2026-10-04T12:00:00.000Z');
    await prisma.$transaction((tx) => queueTransactionalEmailInTransaction(tx, {
      kind: 'DATA_EXPORT_READY', eventId: 'permanent-failure', userId: 'email-outbox-subject',
      recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' }, now,
    }));
    let sends = 0;
    const provider = { sendEmail: async () => { sends += 1; throw new Error(`provider failure ${sends}`); } };
    for (let attempt = 1; attempt <= EMAIL_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await expect(drainEmailOutbox(prisma, provider, now)).resolves.toBe(0);
      const row = await prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:permanent-failure' } });
      expect(row.attempts).toBe(attempt);
      if (attempt < EMAIL_OUTBOX_MAX_ATTEMPTS) now = row.availableAt;
    }
    const parked = await prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:permanent-failure' } });
    expect(parked).toMatchObject({ failedAt: expect.any(Date), processedAt: null, cancelledAt: null, lastError: `provider failure ${EMAIL_OUTBOX_MAX_ATTEMPTS}` });
    expect(parked.lastErrorHistory).toEqual(Array.from({ length: EMAIL_OUTBOX_MAX_ATTEMPTS }, (_, index) => `provider failure ${index + 1}`));
    await expect(drainEmailOutbox(prisma, provider, new Date(now.getTime() + 24 * 60 * 60 * 1000))).resolves.toBe(0);
    expect(sends).toBe(EMAIL_OUTBOX_MAX_ATTEMPTS);
    await expect(emailOutboxHealth(prisma, new Date(now.getTime() + 24 * 60 * 60 * 1000))).resolves.toMatchObject({ parked: 1, longPending: 0 });
  });

  it('retries a transient provider failure and then delivers the same obligation', async () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    await prisma.$transaction((tx) => queueTransactionalEmailInTransaction(tx, {
      kind: 'DATA_EXPORT_READY', eventId: 'transient-failure', userId: 'email-outbox-subject',
      recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' }, now,
    }));
    await drainEmailOutbox(prisma, { sendEmail: async () => { throw new Error('temporary provider failure'); } }, now);
    const retry = await prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:transient-failure' } });
    await expect(drainEmailOutbox(prisma, { sendEmail: async () => ({ ref: 'recovered' }) }, retry.availableAt)).resolves.toBe(1);
    await expect(prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:transient-failure' } })).resolves.toMatchObject({
      attempts: 1, processedAt: expect.any(Date), failedAt: null, lastErrorHistory: ['temporary provider failure'],
    });
  });

  it('cancels outstanding mail for an erased user, but preserves a subsequently queued deletion confirmation', async () => {
    const userId = 'account-deletion-subject';
    await prisma.$transaction(async (tx) => {
      await queueTransactionalEmailInTransaction(tx, {
        kind: 'DATA_EXPORT_READY', eventId: 'before-erasure', userId,
        recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' },
      });
      await cancelPendingEmailOutboxForUser(tx, userId);
      await queueTransactionalEmailInTransaction(tx, {
        kind: 'ACCOUNT_DELETION', eventId: userId, userId,
        recipient: 'person@example.test', template: { kind: 'ACCOUNT_DELETION' },
      });
    });
    await expect(prisma.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: 'email:DATA_EXPORT_READY:before-erasure' } })).resolves.toMatchObject({
      cancelledAt: expect.any(Date), recipient: '[redacted]', body: '[redacted]',
    });
    await expect(drainEmailOutbox(prisma, { sendEmail: async () => ({ ref: 'deletion-confirmation' }) })).resolves.toBe(1);
  });

  it('does not create an email obligation when its fact rolls back', async () => {
    await expect(prisma.$transaction(async (tx) => {
      await queueTransactionalEmailInTransaction(tx, {
        kind: 'DATA_EXPORT_READY', eventId: 'rolled-back', userId: 'email-outbox-subject',
        recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' },
      });
      throw new Error('synthetic transaction rollback');
    })).rejects.toThrow('synthetic transaction rollback');
    await expect(prisma.emailOutbox.count({ where: { dedupeKey: 'email:DATA_EXPORT_READY:rolled-back' } })).resolves.toBe(0);
  });

  it('allows only one concurrent drain to claim and send an obligation', async () => {
    await prisma.$transaction((tx) => queueTransactionalEmailInTransaction(tx, {
      kind: 'DATA_EXPORT_READY', eventId: 'concurrent-drain', userId: 'email-outbox-subject',
      recipient: 'person@example.test', template: { kind: 'DATA_EXPORT_READY' },
    }));
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const sending = new Promise<void>((resolve) => { release = resolve; });
    const claimed = new Promise<void>((resolve) => { started = resolve; });
    let sends = 0;
    const first = drainEmailOutbox(prisma, { sendEmail: async () => { sends += 1; started!(); await sending; return { ref: 'first' }; } });
    await claimed;
    const second = drainEmailOutbox(prisma, { sendEmail: async () => ({ ref: 'second' }) });
    release!();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.sort()).toEqual([0, 1]);
    expect(sends).toBe(1);
  });
});
