import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { drainCheckoutOutbox } from '../modules/order/checkout-outbox';
import { processMoverRevocationOutboxById } from '../modules/mover-revocation-outbox';
import { RatingService } from '../modules/rating/rating.service';
import {
  DEAD_LETTER_CLAIM_GRACE_MS,
  listOutboxDeadLetters,
  requeueOutboxDeadLetter,
  stampExhaustedOutboxRows,
  sweepOutboxDeadLetters,
} from '../jobs/outbox-dead-letter';

// ---------------------------------------------------------------------------
// [row 267 · AUD-L4-021] The three durable outboxes stop retrying forever.
//
// order_outbox (publisher rows), mover_revocation_outbox and rating_outbox
// retried a failing row with backoff for ever (ratings stopped at 25 attempts
// and told nobody). A row now has a retry budget (maxAttempts); once it is
// spent the drain never claims it again, the scheduler sweep stamps it a dead
// letter, the dead-letter alarm pages it, and an operator can requeue it with
// a fresh budget. These run the REAL drains against the database.
// ---------------------------------------------------------------------------

const db = new PrismaClient();
const RUN = randomUUID().replace(/-/g, '').slice(0, 10);
const log = { info: () => {}, warn: () => {}, error: () => {} };
const ids = { order: [] as string[], revocation: [] as string[], rating: [] as string[] };

afterAll(async () => {
  await db.orderOutbox.deleteMany({ where: { id: { in: ids.order } } });
  await db.moverRevocationOutbox.deleteMany({ where: { id: { in: ids.revocation } } });
  await db.ratingOutbox.deleteMany({ where: { id: { in: ids.rating } } });
  await db.$disconnect();
});

async function orderRow(tag: string, data: { kind?: string; attempts: number; maxAttempts?: number; claimedAt?: Date }) {
  const id = `r267-${RUN}-${tag}`;
  ids.order.push(id);
  await db.orderOutbox.create({
    data: {
      id, dedupeKey: id, orderId: `r267-order-${RUN}-${tag}`, kind: data.kind ?? 'dispatch-order', queue: 'dispatch',
      payload: { version: 1, orderId: `r267-order-${RUN}-${tag}` }, attempts: data.attempts,
      ...(data.maxAttempts !== undefined ? { maxAttempts: data.maxAttempts } : {}),
      ...(data.claimedAt ? { claimedAt: data.claimedAt } : {}),
      availableAt: new Date(Date.now() - 60_000),
    },
  });
  return id;
}

const refusingQueue = { add: async () => { throw new Error('queue down'); } };
const acceptingQueue = (added: string[]) => ({ add: async (name: string) => { added.push(name); return {}; } });
const due = (id: string) => db.orderOutbox.update({ where: { id }, data: { availableAt: new Date(Date.now() - 60_000) } });

describe('order_outbox: a publisher row stops at its budget and becomes a dead letter (row 267)', () => {
  it('the last failing attempt spends the budget; the drain never claims the row again; the sweep stamps it; a requeue revives it', async () => {
    const id = await orderRow('spent', { attempts: 2, maxAttempts: 3 });
    const orderIds = [`r267-order-${RUN}-spent`];
    // Attempt 3 of 3 fails.
    expect(await drainCheckoutOutbox({ prisma: db, queues: { dispatchQueue: refusingQueue }, log }, { orderIds })).toEqual({ processed: 0, failed: 1 });
    expect(await db.orderOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({ attempts: 3, lastError: 'queue down', processedAt: null });
    // Due again, but spent: not claimed, not retried.
    await due(id);
    expect(await drainCheckoutOutbox({ prisma: db, queues: { dispatchQueue: refusingQueue }, log }, { orderIds })).toEqual({ processed: 0, failed: 0 });
    expect((await db.orderOutbox.findUniqueOrThrow({ where: { id } })).attempts).toBe(3);

    // The scheduler sweep stamps it and reports it.
    const sweep = await sweepOutboxDeadLetters(db);
    expect(sweep.stamped['order-outbox']).toBeGreaterThanOrEqual(1);
    expect(sweep.queues.find((q) => q.queue === 'order-outbox')?.count).toBeGreaterThanOrEqual(1);
    const stamped = await db.orderOutbox.findUniqueOrThrow({ where: { id } });
    expect(stamped.deadLetteredAt).toBeInstanceOf(Date);
    const listed = (await listOutboxDeadLetters(db, 200)).find((r) => r.id === id);
    expect(listed).toMatchObject({ queue: 'order-outbox', name: 'dispatch-order', failedReason: 'queue down', attemptsMade: 3, finishedOn: stamped.deadLetteredAt!.getTime() });

    // A stale requeue (another stamp) is refused; the right one revives it once.
    expect(await requeueOutboxDeadLetter(db, 'order-outbox', id, stamped.deadLetteredAt!.getTime() - 1)).toBe(false);
    expect(await requeueOutboxDeadLetter(db, 'order-outbox', id, stamped.deadLetteredAt!.getTime())).toBe(true);
    expect(await requeueOutboxDeadLetter(db, 'order-outbox', id, stamped.deadLetteredAt!.getTime())).toBe(false);
    expect(await db.orderOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({ attempts: 0, deadLetteredAt: null, claimedAt: null });
    const added: string[] = [];
    expect(await drainCheckoutOutbox({ prisma: db, queues: { dispatchQueue: acceptingQueue(added) }, log }, { orderIds })).toEqual({ processed: 1, failed: 0 });
    expect(added).toEqual(['dispatch-order']);
    expect((await db.orderOutbox.findUniqueOrThrow({ where: { id } })).processedAt).toBeInstanceOf(Date);
  });

  it('a row still inside its last claim is not stamped until the claim has certainly lapsed', async () => {
    const now = new Date();
    const id = await orderRow('claimed', { attempts: 3, maxAttempts: 3, claimedAt: now });
    await stampExhaustedOutboxRows(db, now);
    expect((await db.orderOutbox.findUniqueOrThrow({ where: { id } })).deadLetteredAt).toBeNull();
    await stampExhaustedOutboxRows(db, new Date(now.getTime() + DEAD_LETTER_CLAIM_GRACE_MS + 1_000));
    expect((await db.orderOutbox.findUniqueOrThrow({ where: { id } })).deadLetteredAt).toBeInstanceOf(Date);
  });

  it('an in-process notice row is never judged by the sweep (it has its own delivery window)', async () => {
    const id = await orderRow('notice', { kind: 'rider-cancel-notice', attempts: 40, maxAttempts: 3 });
    await stampExhaustedOutboxRows(db);
    expect((await db.orderOutbox.findUniqueOrThrow({ where: { id } })).deadLetteredAt).toBeNull();
    expect((await listOutboxDeadLetters(db, 200)).some((r) => r.id === id)).toBe(false);
  });

  it('existing rows take a budget of 20', async () => {
    const id = await orderRow('default', { attempts: 0 });
    expect((await db.orderOutbox.findUniqueOrThrow({ where: { id } })).maxAttempts).toBe(20);
  });
});

describe('mover_revocation_outbox: a spent revocation is not retried; it waits, paged, for an operator (row 267)', () => {
  it('the claim refuses a spent row, the sweep stamps it, and a requeue gives it a fresh budget', async () => {
    const id = `r267-${RUN}-revoke`;
    ids.revocation.push(id);
    await db.moverRevocationOutbox.create({
      data: { id, dedupeKey: id, userId: `r267-user-${RUN}`, payload: { orders: [] }, attempts: 4, maxAttempts: 4, lastError: 'push provider down', availableAt: new Date(Date.now() - 60_000) },
    });
    // Nothing is claimed, so no effect runs (the runtime here has none to run).
    expect(await processMoverRevocationOutboxById({ prisma: db } as never, id)).toBe(false);
    expect((await db.moverRevocationOutbox.findUniqueOrThrow({ where: { id } })).attempts).toBe(4);
    const sweep = await sweepOutboxDeadLetters(db);
    expect(sweep.queues.find((q) => q.queue === 'mover-revocation-outbox')?.count).toBeGreaterThanOrEqual(1);
    const row = await db.moverRevocationOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.deadLetteredAt).toBeInstanceOf(Date);
    expect((await listOutboxDeadLetters(db, 200)).find((r) => r.id === id)).toMatchObject({ queue: 'mover-revocation-outbox', name: 'revoke-mover', failedReason: 'push provider down' });
    expect(await requeueOutboxDeadLetter(db, 'mover-revocation-outbox', id, row.deadLetteredAt!.getTime())).toBe(true);
    expect(await db.moverRevocationOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({ attempts: 0, deadLetteredAt: null });
  });
});

describe('rating_outbox: the budget is the row own, and a spent command pages instead of vanishing (row 267)', () => {
  it('a spent command is not processed, is stamped, listed and requeueable; the default budget stays 25', async () => {
    const id = `r267-${RUN}-rating`;
    ids.rating.push(id);
    const ratingId = `r267-rating-${RUN}`;
    await db.ratingOutbox.create({ data: { id, ratingId, command: 'STATS', attempts: 3, maxAttempts: 3, lastError: 'stats store down', availableAt: new Date(Date.now() - 60_000) } });
    const result = await new RatingService(db).processRatingOutbox({ ratingId });
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(await db.ratingOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({ attempts: 3, processedAt: null });
    await sweepOutboxDeadLetters(db);
    const row = await db.ratingOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.deadLetteredAt).toBeInstanceOf(Date);
    expect((await listOutboxDeadLetters(db, 200)).find((r) => r.id === id)).toMatchObject({ queue: 'rating-outbox', name: 'STATS', failedReason: 'stats store down' });
    expect(await requeueOutboxDeadLetter(db, 'rating-outbox', id)).toBe(true);
    const fresh = `r267-${RUN}-rating-default`;
    ids.rating.push(fresh);
    await db.ratingOutbox.create({ data: { id: fresh, ratingId: `${ratingId}-d`, command: 'STATS' } });
    expect((await db.ratingOutbox.findUniqueOrThrow({ where: { id: fresh } })).maxAttempts).toBe(25);
  });
});

describe('the dead letters reach a person (row 267)', () => {
  it('the scheduler heartbeat sweeps the outboxes and pages them on the dead-letter alarm', () => {
    const queue = readFileSync(join(process.cwd(), 'src/jobs/queue.ts'), 'utf8');
    const heartbeat = queue.slice(queue.indexOf("if (job.name === 'scheduler-heartbeat')"));
    const block = heartbeat.slice(heartbeat.indexOf('sweepOutboxDeadLetters('), heartbeat.indexOf('sweepOutboxDeadLetters(') + 1_500);
    expect(heartbeat.indexOf('sweepOutboxDeadLetters(')).toBeGreaterThan(0);
    expect(block).toMatch(/opsPageOnce\(ctx, 'outbox-dead-letter'/);
    expect(block).toMatch(/kind: 'ops_dlq_non_empty'/);
  });
});
