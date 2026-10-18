import type { PrismaClient } from '@prisma/client';
import { IN_PROCESS_OUTBOX_KINDS } from '../modules/order/checkout-outbox';
import type { Recovery } from './recovery-policy';

// ---------------------------------------------------------------------------
// [row 267 · AUD-L4-021] THE OUTBOXES' DEAD LETTERS.
//
// Three durable outboxes carry commands a request committed but could not
// finish itself: order_outbox (its publisher rows: a dispatch command, an
// auto-cancel, a vendor alert ladder), mover_revocation_outbox (a mover whose
// session or authority must end) and rating_outbox (a safety intake, a
// double-blind release, a stats update). Each drain retried a failing row with
// backoff, for ever; the rating drain stopped at 25 attempts and told nobody.
// A row that can never succeed was invisible either way.
//
// Each row now carries its retry budget (maxAttempts) and, once it is spent,
// a dead-letter stamp (deadLetteredAt):
//   * the drains never claim an exhausted row again (their claim predicates);
//   * the scheduler sweep stamps it once its last claim has lapsed;
//   * the same alarm as BullMQ's dead letters pages it (ops_dlq_non_empty);
//   * the admin Background jobs page lists it beside the dead jobs, and an
//     operator can requeue it with a fresh budget. Nothing is ever deleted.
// The in-process order_outbox kinds (claim/handover/rescue/cancel notices)
// have their own delivery windows and are not this sweep's to judge.
// ---------------------------------------------------------------------------

export const OUTBOX_DEAD_LETTER_NAMES = ['order-outbox', 'mover-revocation-outbox', 'rating-outbox'] as const;
export type OutboxDeadLetterName = typeof OUTBOX_DEAD_LETTER_NAMES[number];

export function isOutboxDeadLetterName(name: string): name is OutboxDeadLetterName {
  return (OUTBOX_DEAD_LETTER_NAMES as readonly string[]).includes(name);
}

/** A row whose last claim is older than this has certainly finished running
 *  (both claim leases are 60 s, the revocation effect timeout is shorter). */
export const DEAD_LETTER_CLAIM_GRACE_MS = 10 * 60_000;

/** What an operator may do with an outbox dead letter. */
export const OUTBOX_RECOVERY: Recovery = {
  policy: 'SAFE_REPLAY',
  why: 'An outbox row is an owed command, claimed under a lease and marked processed once: the order publisher adds its job under jobId = row id, the revocation effects and the rating commands are idempotent by construction. A requeue gives the same row a fresh retry budget; nothing runs twice that has already run.',
};

const publisherRows = { kind: { notIn: [...IN_PROCESS_OUTBOX_KINDS] } };

/** Stamp every row whose retry budget is spent and whose last claim has lapsed. */
export async function stampExhaustedOutboxRows(prisma: PrismaClient, now: Date = new Date()): Promise<Record<OutboxDeadLetterName, number>> {
  const lapsed = [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - DEAD_LETTER_CLAIM_GRACE_MS) } }];
  const data = { deadLetteredAt: now, claimedAt: null };
  const order = await prisma.orderOutbox.updateMany({
    where: { ...publisherRows, processedAt: null, deadLetteredAt: null, attempts: { gte: prisma.orderOutbox.fields.maxAttempts }, OR: lapsed },
    data,
  });
  const revocation = await prisma.moverRevocationOutbox.updateMany({
    where: { processedAt: null, deadLetteredAt: null, attempts: { gte: prisma.moverRevocationOutbox.fields.maxAttempts }, OR: lapsed },
    data,
  });
  const rating = await prisma.ratingOutbox.updateMany({
    where: { processedAt: null, deadLetteredAt: null, attempts: { gte: prisma.ratingOutbox.fields.maxAttempts }, OR: lapsed },
    data,
  });
  return { 'order-outbox': order.count, 'mover-revocation-outbox': revocation.count, 'rating-outbox': rating.count };
}

const dead = { processedAt: null, deadLetteredAt: { not: null } };

/** How many dead letters each outbox holds now. */
export async function countOutboxDeadLetters(prisma: PrismaClient): Promise<Record<OutboxDeadLetterName, number>> {
  return {
    'order-outbox': await prisma.orderOutbox.count({ where: { ...publisherRows, ...dead } }),
    'mover-revocation-outbox': await prisma.moverRevocationOutbox.count({ where: dead }),
    'rating-outbox': await prisma.ratingOutbox.count({ where: dead }),
  };
}

/** One scheduler pass: stamp what is newly exhausted, then report every outbox holding dead letters. */
export async function sweepOutboxDeadLetters(prisma: PrismaClient, now: Date = new Date()): Promise<{
  stamped: Record<OutboxDeadLetterName, number>;
  queues: Array<{ queue: OutboxDeadLetterName; count: number }>;
  total: number;
}> {
  const stamped = await stampExhaustedOutboxRows(prisma, now);
  const counts = await countOutboxDeadLetters(prisma);
  const queues = OUTBOX_DEAD_LETTER_NAMES.filter((q) => counts[q] > 0).map((queue) => ({ queue, count: counts[queue] }));
  return { stamped, queues, total: queues.reduce((sum, q) => sum + q.count, 0) };
}

export interface OutboxDeadLetter {
  queue: OutboxDeadLetterName;
  id: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  data: string;
  finishedOn: number;
}

/** The dead letters as the admin Background jobs page shows a dead job (payload preview only). */
export async function listOutboxDeadLetters(prisma: PrismaClient, take = 50): Promise<OutboxDeadLetter[]> {
  const preview = (payload: unknown) => JSON.stringify(payload ?? {}).slice(0, 500);
  const select = { id: true, attempts: true, lastError: true, deadLetteredAt: true, payload: true } as const;
  const order = await prisma.orderOutbox.findMany({ where: { ...publisherRows, ...dead }, orderBy: { deadLetteredAt: 'desc' }, take, select: { ...select, kind: true } });
  const revocation = await prisma.moverRevocationOutbox.findMany({ where: dead, orderBy: { deadLetteredAt: 'desc' }, take, select });
  const rating = await prisma.ratingOutbox.findMany({ where: dead, orderBy: { deadLetteredAt: 'desc' }, take, select: { ...select, command: true } });
  const row = (queue: OutboxDeadLetterName, name: string, r: { id: string; attempts: number; lastError: string | null; deadLetteredAt: Date | null; payload: unknown }): OutboxDeadLetter => ({
    queue, id: r.id, name, failedReason: r.lastError, attemptsMade: r.attempts, data: preview(r.payload), finishedOn: r.deadLetteredAt?.getTime() ?? 0,
  });
  return [
    ...order.map((r) => row('order-outbox', r.kind, r)),
    ...revocation.map((r) => row('mover-revocation-outbox', 'revoke-mover', r)),
    ...rating.map((r) => row('rating-outbox', r.command, r)),
  ];
}

/** Give one dead letter a fresh retry budget. Compare-and-set on the stamp the
 *  operator was looking at: false when it is no longer that dead letter. */
export async function requeueOutboxDeadLetter(
  prisma: PrismaClient,
  queue: OutboxDeadLetterName,
  id: string,
  expectedDeadLetteredAt?: number,
  now: Date = new Date(),
): Promise<boolean> {
  const where = { id, processedAt: null, deadLetteredAt: expectedDeadLetteredAt !== undefined ? new Date(expectedDeadLetteredAt) : { not: null } };
  const data = { deadLetteredAt: null, attempts: 0, claimedAt: null, availableAt: now };
  const result = queue === 'order-outbox'
    ? await prisma.orderOutbox.updateMany({ where, data })
    : queue === 'mover-revocation-outbox'
      ? await prisma.moverRevocationOutbox.updateMany({ where, data })
      : await prisma.ratingOutbox.updateMany({ where, data });
  return result.count === 1;
}
