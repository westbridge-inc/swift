import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { vendorResponseSlaMinutes } from './response-sla';

/**
 * [M-11] The checkout command's durable tail and result.
 *
 * Before: the order transaction committed, then the route awaited two
 * fallible queue publications (the vendor alert ladder, the auto-cancel),
 * then invalidated caches, then stored the idempotent result in Redis on a
 * best-effort basis, then answered. A queue outage after the commit answered
 * the customer with a 500 for an order that exists, dropped the auto-cancel
 * that keeps a never-accepted order from hanging forever, and — because the
 * generic idempotency helper releases the key when its callback throws —
 * left a same-key retry free to place a SECOND order. A lost Redis write
 * downgraded a legitimate replay to "empty cart".
 *
 * Now:
 * - the queue work is written INSIDE the order transaction as outbox rows
 *   (one deterministic row per effect) and published by a leased,
 *   idempotent drainer (BullMQ job id = outbox row id): the route drains its
 *   own rows immediately, the worker sweep reclaims anything a crash or an
 *   outage left behind;
 * - the result is written INSIDE the same transaction as a receipt keyed by
 *   (customer, idempotency key) with the request's fingerprint, so a replay
 *   is answered from the database even if Redis forgot, and a same-key
 *   request with a different body is refused instead of quietly paired with
 *   an order it did not ask for.
 */

export const CHECKOUT_OUTBOX_VERSION = 1 as const;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

export type CheckoutOutboxKind = 'vendor-alert-escalate' | 'auto-cancel';
export type CheckoutOutboxQueue = 'order' | 'notification' | 'dispatch';

export interface CheckoutQueueTiming {
  /** The vendor alert ladder's first re-alert. */
  alertDelayMs: number;
  /** Hold window (LIFECYCLE_V2) plus the vendor response SLA. */
  autoCancelDelayMs: number;
}

export interface CheckoutOutboxRuntime {
  prisma: PrismaClient;
  queues: { orderQueue: Pick<Queue, 'add'>; notificationQueue: Pick<Queue, 'add'>
    /** [S-13] the dispatch queue — a `dispatch` row publishes a dispatch-order job */
    dispatchQueue?: { add: (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown> };
  };
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

interface ClaimedRow {
  id: string;
  orderId: string;
  kind: string;
  queue: string;
  payload: Prisma.JsonValue;
  delayMs: number;
  attempts: number;
  createdAt: Date;
}

function stableToken(input: string, length = 24): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/** Deterministic row id — also the BullMQ job id, so a re-publish of the
 *  same row while the job still exists is a no-op on the queue's side. */
export function checkoutOutboxId(dedupeKey: string): string {
  return `oob_${stableToken(dedupeKey)}`;
}

export function checkoutOutboxDedupeKey(orderId: string, kind: CheckoutOutboxKind): string {
  return `order:${orderId}:${kind}`;
}

/** The request's fingerprint: canonical JSON (sorted keys) of what the
 *  customer asked for. Two requests with the same key must ask the same
 *  thing; otherwise the second is refused, never answered with the first's
 *  order. */
export function checkoutRequestHash(body: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(body ?? {}))).digest('hex');
}

/** The delays the two effects carry — computed BEFORE the transaction so the
 *  rows inside it are complete. Same arithmetic the route used to do after
 *  the commit; the preview and the writer must never disagree [F036-03b]. */
export async function checkoutQueueTiming(prisma: PrismaClient): Promise<CheckoutQueueTiming> {
  const holdMin = process.env['LIFECYCLE_V2'] === '1' ? Number(process.env['ORDER_HOLD_MINUTES'] ?? 5) : 0;
  const slaMin = await vendorResponseSlaMinutes(prisma);
  return {
    alertDelayMs: process.env['ALERTS_LOUD'] === '1' ? 30_000 : 60_000,
    autoCancelDelayMs: (holdMin + slaMin) * 60_000,
  };
}

/**
 * Write the order's queue work as outbox rows, inside the caller's
 * transaction. Idempotent: deterministic ids and dedupe keys, duplicates
 * skipped. Nothing is published here — that is the drainer's job, after the
 * commit that makes these rows real.
 */
export async function persistCheckoutOutboxInTransaction(
  tx: Prisma.TransactionClient,
  input: { orders: Array<{ id: string; tenantId: string }>; timing: CheckoutQueueTiming; now?: Date },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const rows: Prisma.OrderOutboxCreateManyInput[] = [];
  for (const order of input.orders) {
    const effects: Array<{ kind: CheckoutOutboxKind; queue: CheckoutOutboxQueue; payload: Prisma.InputJsonValue; delayMs: number }> = [
      { kind: 'vendor-alert-escalate', queue: 'notification', payload: { orderId: order.id, level: 0 }, delayMs: input.timing.alertDelayMs },
      { kind: 'auto-cancel', queue: 'order', payload: { orderId: order.id }, delayMs: input.timing.autoCancelDelayMs },
    ];
    for (const e of effects) {
      const dedupeKey = checkoutOutboxDedupeKey(order.id, e.kind);
      rows.push({
        id: checkoutOutboxId(dedupeKey),
        tenantId: order.tenantId,
        dedupeKey,
        orderId: order.id,
        kind: e.kind,
        queue: e.queue,
        payload: { version: CHECKOUT_OUTBOX_VERSION, ...(e.payload as Record<string, unknown>) } as Prisma.InputJsonValue,
        delayMs: e.delayMs,
        availableAt: now,
      });
    }
  }
  if (rows.length) await tx.orderOutbox.createMany({ data: rows, skipDuplicates: true });
  return rows.map((r) => r.id);
}

/** [S-13] A durable dispatch command, inside the caller's transaction: the
 *  order must be dispatched again, whatever happens to the process after the
 *  commit. Deterministic id = the BullMQ jobId, so an inline fast-path enqueue
 *  and the drainer's publish are the same job. */
export function dispatchCommandDedupeKey(orderId: string, reason: string): string {
  return `order:${orderId}:redispatch:${reason}`;
}
export async function persistDispatchCommandInTransaction(
  tx: Prisma.TransactionClient,
  input: { orderId: string; tenantId: string; reason: string; now?: Date },
): Promise<{ id: string; dedupeKey: string }> {
  const dedupeKey = dispatchCommandDedupeKey(input.orderId, input.reason);
  const id = checkoutOutboxId(dedupeKey);
  await tx.orderOutbox.createMany({
    data: [{ id, tenantId: input.tenantId, dedupeKey, orderId: input.orderId, kind: 'dispatch-order', queue: 'dispatch', payload: { version: CHECKOUT_OUTBOX_VERSION, orderId: input.orderId, reason: input.reason } as Prisma.InputJsonValue, delayMs: 0, availableAt: input.now ?? new Date() }],
    skipDuplicates: true,
  });
  return { id, dedupeKey };
}

/** Write the command's one immutable result, inside the caller's transaction. */
export async function persistCheckoutReceiptInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; tenantId: string; idempotencyKey: string; requestHash: string; orderIds: string[]; result: unknown },
): Promise<void> {
  await tx.checkoutReceipt.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      orderIds: input.orderIds,
      // The same serialization the wire uses: Decimals become strings here
      // exactly as they do in the response, so a replay is byte-equivalent.
      result: JSON.parse(JSON.stringify(input.result)) as Prisma.InputJsonValue,
    },
  });
}

export async function findCheckoutReceipt(
  prisma: PrismaClient,
  userId: string,
  idempotencyKey: string,
): Promise<{ requestHash: string; orderIds: string[]; result: Prisma.JsonValue } | null> {
  return prisma.checkoutReceipt.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: { requestHash: true, orderIds: true, result: true },
  });
}

function claimLeaseMs(): number {
  const v = Number(process.env['ORDER_OUTBOX_CLAIM_LEASE_MS']);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CLAIM_LEASE_MS;
}

function retryDelayMs(attempts: number): number {
  const base = Math.max(100, Number(process.env['ORDER_OUTBOX_RETRY_BASE_MS']) || DEFAULT_RETRY_BASE_MS);
  const cap = Math.max(base, Number(process.env['ORDER_OUTBOX_RETRY_MAX_MS']) || DEFAULT_RETRY_MAX_MS);
  return Math.min(cap, base * (2 ** Math.min(Math.max(0, attempts - 1), 10)));
}

/** Claim one due row with a lease: a crashed drainer's row becomes
 *  claimable again when its lease lapses; two drainers never hold one row
 *  (FOR UPDATE SKIP LOCKED). Same shape as the mover-revocation outbox. */
async function claimNextRow(prisma: PrismaClient, options: { orderIds?: string[]; leaseMs: number }): Promise<ClaimedRow | null> {
  const orderFilter = options.orderIds?.length ? Prisma.sql`AND "orderId" = ANY(${options.orderIds})` : Prisma.empty;
  const rows = await prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id"
      FROM "order_outbox"
      WHERE "processedAt" IS NULL
        AND "availableAt" <= CURRENT_TIMESTAMP
        AND (
          "claimedAt" IS NULL
          OR "claimedAt" < CURRENT_TIMESTAMP - (${options.leaseMs} * INTERVAL '1 millisecond')
        )
        ${orderFilter}
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "order_outbox" AS outbox
    SET "claimedAt" = CURRENT_TIMESTAMP,
        "attempts" = outbox."attempts" + 1,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate
    WHERE outbox."id" = candidate."id"
    RETURNING outbox."id", outbox."orderId", outbox."kind", outbox."queue", outbox."payload",
              outbox."delayMs", outbox."attempts", outbox."createdAt"
  `);
  return rows[0] ?? null;
}

/**
 * Publish due outbox rows to their queues. Idempotent on the row (processedAt)
 * and on the queue (job id = row id). A failed publish records the error,
 * backs the row off, and releases the claim so the next sweep retries it.
 * `orderIds` narrows the drain to the rows a request just wrote (low latency);
 * the worker sweep runs it unfiltered.
 */
export async function drainCheckoutOutbox(
  runtime: CheckoutOutboxRuntime,
  options: { orderIds?: string[]; limit?: number; claimLeaseMs?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const leaseMs = Math.max(1_000, options.claimLeaseMs ?? claimLeaseMs());
  const limit = Math.max(1, options.limit ?? 200);
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const row = await claimNextRow(runtime.prisma, { ...(options.orderIds ? { orderIds: options.orderIds } : {}), leaseMs });
    if (!row) break;
    try {
      const queue = row.queue === 'dispatch' ? runtime.queues.dispatchQueue : row.queue === 'order' ? runtime.queues.orderQueue : runtime.queues.notificationQueue;
      if (!queue) throw new Error(`no ${row.queue} queue in this runtime`);
      const payload = { ...((row.payload ?? {}) as Record<string, unknown>) };
      delete payload['version'];
      await queue.add(row.kind, payload, {
        jobId: row.id,
        delay: Math.max(0, row.delayMs - Math.max(0, Date.now() - row.createdAt.getTime())),
        removeOnComplete: 100,
        removeOnFail: 50,
      });
      await runtime.prisma.orderOutbox.update({ where: { id: row.id }, data: { processedAt: new Date(), claimedAt: null } });
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
      await runtime.prisma.orderOutbox.update({
        where: { id: row.id },
        data: { claimedAt: null, lastError: message, availableAt: new Date(Date.now() + retryDelayMs(row.attempts)) },
      }).catch(() => {});
      runtime.log.warn({ err, outboxId: row.id, orderId: row.orderId, kind: row.kind, attempts: row.attempts }, '[M-11] checkout outbox publish failed — will retry');
    }
  }
  return { processed, failed };
}
