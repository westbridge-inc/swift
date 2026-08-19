import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { getChannels, type NotificationChannels } from '../providers/notifications/channels';
import { closeOnlineSession } from './rider/online-hours';
import { EvidenceService } from './safety/evidence.service';
import { persistMoverCustodyLossIncidentInTransaction } from './safety/incident.service';
import { positiveDurationMs, withTimeout } from '../utils/async-lifecycle';

const OUTBOX_VERSION = 1 as const;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const DEFAULT_EFFECT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;

export interface MoverRevocationOrderEffect {
  orderId: string;
  orderNumber: string;
  customerId: string;
  pool: 'RIDER' | 'DRIVER';
  status: string;
  action: 'REDISPATCH' | 'ESCALATE';
}

export interface MoverRevocationCleanupEffect {
  riderId: string | null;
  driverId: string | null;
  orders: MoverRevocationOrderEffect[];
}

interface DurableOrderEffect extends MoverRevocationOrderEffect {
  customerNotificationId: string;
  subjectNotificationId: string | null;
  incidentId: string | null;
  adminNotificationIds: string[];
}

export interface MoverRevocationOutboxPayload {
  version: typeof OUTBOX_VERSION;
  riderId: string | null;
  driverId: string | null;
  orders: DurableOrderEffect[];
}

export interface MoverRevocationDispatchEffects {
  releaseHeldOffer(moverId: string): Promise<void>;
  retryDispatch(orderId: string): Promise<unknown>;
}

export interface MoverRevocationOutboxRuntime {
  prisma: PrismaClient;
  redis: Redis;
  io: Server;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  dispatch: MoverRevocationDispatchEffects;
  /** Injectable for focused failure tests; production resolves the configured
   * Expo/dev provider once per claimed event. */
  channels?: Pick<NotificationChannels, 'push'>;
}

interface ClaimedOutboxRow {
  id: string;
  userId: string;
  payload: Prisma.JsonValue;
  attempts: number;
  claimedAt: Date;
}

function claimLeaseMs(): number {
  return positiveDurationMs(process.env['MOVER_REVOCATION_CLAIM_LEASE_MS'], DEFAULT_CLAIM_LEASE_MS);
}

function effectTimeoutMs(): number {
  const leaseMs = claimLeaseMs();
  const configured = positiveDurationMs(
    process.env['MOVER_REVOCATION_EFFECT_TIMEOUT_MS'],
    DEFAULT_EFFECT_TIMEOUT_MS,
  );
  // A timed-out owner must release/back off the row before another worker may
  // reclaim its lease. Preserve a positive deadline even in focused tests.
  return Math.max(1, Math.min(configured, Math.max(1, leaseMs - 1_000)));
}

function stableToken(input: string, length = 24): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function customerCopy(order: MoverRevocationOrderEffect): { title: string; body: string } {
  if (order.action === 'REDISPATCH') {
    return order.pool === 'DRIVER'
      ? {
          title: 'Finding you another driver',
          body: 'Your driver went offline before pickup. We are matching you with another nearby driver now.',
        }
      : {
          title: 'Finding you another rider',
          body: 'Your rider went offline before pickup. We are matching your order with another nearby rider now.',
        };
  }
  return order.pool === 'DRIVER'
    ? {
        title: 'Your driver went offline',
        body: 'The ride remains active because you are already in the vehicle. Operations has been alerted to contact both parties.',
      }
    : {
        title: 'Your rider went offline',
        body: 'The delivery remains assigned because your rider already has the order. Operations has been alerted to contact both parties.',
      };
}

function opsCopy(order: MoverRevocationOrderEffect): { title: string; body: string } {
  return order.pool === 'DRIVER'
    ? {
        title: 'Driver signed out with passenger aboard',
        body: `${order.orderNumber} remains ${order.status}. Contact both parties immediately; do not auto-reassign physical custody.`,
      }
    : {
        title: 'Rider signed out with order in custody',
        body: `${order.orderNumber} remains ${order.status}. Contact both parties immediately; do not auto-reassign physical custody.`,
      };
}

function hasEffects(cleanup: MoverRevocationCleanupEffect): boolean {
  return Boolean(cleanup.riderId || cleanup.driverId || cleanup.orders.length > 0);
}

/**
 * Persist the recoverable half of a mover-session revocation in the SAME
 * transaction as the session/profile/order authority change.
 *
 * Customer inbox rows and custody IncidentCases are facts, not delivery
 * attempts, so they are committed here. Their deterministic primary keys make
 * replay harmless even if a caller repeats the same dedupe key. Redis cleanup,
 * redispatch, push/socket fan-out and online-hours folding stay in the outbox.
 */
export async function persistMoverRevocationOutboxInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    dedupeKey: string;
    userId: string;
    cleanup: MoverRevocationCleanupEffect;
    now?: Date;
  },
): Promise<string | null> {
  if (!hasEffects(input.cleanup)) return null;

  const now = input.now ?? new Date();
  const outboxId = `mro_${stableToken(input.dedupeKey)}`;
  const user = await tx.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { tenantId: true },
  });
  const admins = input.cleanup.orders.some((order) => order.action === 'ESCALATE')
    ? await tx.user.findMany({
        where: {
          tenantId: user.tenantId,
          roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] },
          status: 'ACTIVE',
        },
        select: { id: true },
      })
    : [];

  const notificationRows: Prisma.NotificationCreateManyInput[] = [];
  const alertRows: Prisma.AlertDeliveryCreateManyInput[] = [];
  const orders: DurableOrderEffect[] = [];

  for (const order of input.cleanup.orders) {
    const effectKey = `${input.dedupeKey}:order:${order.orderId}:${order.action}`;
    const customerNotificationId = `mro_notice_${stableToken(`${effectKey}:customer`)}`;
    const customer = customerCopy(order);
    notificationRows.push({
      id: customerNotificationId,
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: customer.title,
      body: customer.body,
      data: {
        audience: 'customer',
        kind: 'mover_session_revocation',
        eventId: `${outboxId}:${order.orderId}`,
        orderId: order.orderId,
        status: order.status,
        action: order.action,
      },
      createdAt: now,
    });

    let incidentId: string | null = null;
    let subjectNotificationId: string | null = null;
    const adminNotificationIds: string[] = [];
    if (order.action === 'ESCALATE') {
      incidentId = `mro_inc_${stableToken(effectKey)}`;
      subjectNotificationId = `mro_subject_${stableToken(`${effectKey}:subject`)}`;
      const caseNumber = `INC-RV-${stableToken(effectKey, 10).toUpperCase()}`;
      const ops = opsCopy(order);
      const incident = await persistMoverCustodyLossIncidentInTransaction(tx, {
        incidentId,
        caseNumber,
        subjectNotificationId,
        eventId: `${outboxId}:${order.orderId}`,
        tenantId: user.tenantId,
        subjectUserId: input.userId,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        pool: order.pool,
        status: order.status,
        summary: ops.body,
        now,
      });

      for (const admin of admins) {
        const notificationId = `mro_ops_${stableToken(`${effectKey}:admin:${admin.id}`)}`;
        adminNotificationIds.push(notificationId);
        notificationRows.push({
          id: notificationId,
          userId: admin.id,
          type: 'SYSTEM_ANNOUNCEMENT',
          title: ops.title,
          body: ops.body,
          data: {
            kind: `ops_mover_session_ended:${order.orderId}`,
            eventId: `${outboxId}:${order.orderId}`,
            orderId: order.orderId,
            incidentId,
            severity: incident.severity,
          },
          createdAt: now,
        });
        alertRows.push({
          id: `mro_alert_${stableToken(`${effectKey}:admin:${admin.id}`)}`,
          kind: 'ADMIN_OPS',
          subjectId: `ops_mover_session_ended:${order.orderId}`,
          recipientId: admin.id,
          sentAt: now,
        });
      }
    }

    orders.push({
      ...order,
      customerNotificationId,
      subjectNotificationId,
      incidentId,
      adminNotificationIds,
    });
  }

  if (notificationRows.length > 0) {
    await tx.notification.createMany({ data: notificationRows, skipDuplicates: true });
  }
  if (alertRows.length > 0) {
    await tx.alertDelivery.createMany({ data: alertRows, skipDuplicates: true });
  }

  const payload: MoverRevocationOutboxPayload = {
    version: OUTBOX_VERSION,
    riderId: input.cleanup.riderId,
    driverId: input.cleanup.driverId,
    orders,
  };
  await tx.moverRevocationOutbox.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      id: outboxId,
      dedupeKey: input.dedupeKey,
      userId: input.userId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    update: {},
  });
  return outboxId;
}

function parsePayload(value: Prisma.JsonValue): MoverRevocationOutboxPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Mover revocation outbox payload is not an object');
  }
  const payload = value as unknown as Partial<MoverRevocationOutboxPayload>;
  if (
    payload.version !== OUTBOX_VERSION
    || !Array.isArray(payload.orders)
    || (payload.riderId !== null && typeof payload.riderId !== 'string')
    || (payload.driverId !== null && typeof payload.driverId !== 'string')
  ) {
    throw new Error('Mover revocation outbox payload has an unsupported shape');
  }
  return payload as MoverRevocationOutboxPayload;
}

async function claimNextOutboxRow(
  prisma: PrismaClient,
  options: { id?: string; claimLeaseMs?: number } = {},
): Promise<ClaimedOutboxRow | null> {
  const leaseMs = Math.max(1_000, options.claimLeaseMs ?? claimLeaseMs());
  const idFilter = options.id ? Prisma.sql`AND "id" = ${options.id}` : Prisma.empty;
  const rows = await prisma.$queryRaw<ClaimedOutboxRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id"
      FROM "mover_revocation_outbox"
      WHERE "processedAt" IS NULL
        AND "availableAt" <= CURRENT_TIMESTAMP
        AND (
          "claimedAt" IS NULL
          OR "claimedAt" < CURRENT_TIMESTAMP - (${leaseMs} * INTERVAL '1 millisecond')
        )
        ${idFilter}
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "mover_revocation_outbox" AS outbox
    SET "claimedAt" = CURRENT_TIMESTAMP,
        "attempts" = outbox."attempts" + 1,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate
    WHERE outbox."id" = candidate."id"
    RETURNING outbox."id", outbox."userId", outbox."payload",
              outbox."attempts", outbox."claimedAt"
  `);
  return rows[0] ?? null;
}

function retryDelayMs(attempts: number): number {
  const base = Math.max(100, Number(process.env['MOVER_REVOCATION_RETRY_BASE_MS']) || DEFAULT_RETRY_BASE_MS);
  const cap = Math.max(base, Number(process.env['MOVER_REVOCATION_RETRY_MAX_MS']) || DEFAULT_RETRY_MAX_MS);
  return Math.min(cap, base * (2 ** Math.min(Math.max(0, attempts - 1), 10)));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

async function emitDurableNotifications(
  runtime: MoverRevocationOutboxRuntime,
  payload: MoverRevocationOutboxPayload,
): Promise<void> {
  const ids = payload.orders.flatMap((order) => [
    order.customerNotificationId,
    ...(order.subjectNotificationId ? [order.subjectNotificationId] : []),
    ...order.adminNotificationIds,
  ]);
  if (ids.length === 0) return;
  const notifications = await runtime.prisma.notification.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true, type: true, title: true, body: true, data: true, createdAt: true },
  });
  for (const notification of notifications) {
    runtime.io.to(`user:${notification.userId}`).emit('notification', notification);
  }

  // Preserve the pre-outbox behavior for a killed/backgrounded app: durable
  // inbox rows alone are not an immediate alert. Provider failure throws so
  // the PostgreSQL outbox retries it; the stable notificationId/eventId make
  // the delivery logically idempotent even though external push is at-least-once.
  const userIds = [...new Set(notifications.map((notification) => notification.userId))];
  const [users, tokens] = await Promise.all([
    runtime.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, notificationPrefs: true },
    }),
    runtime.prisma.deviceToken.findMany({
      where: { userId: { in: userIds }, isActive: true },
      select: { userId: true, token: true },
    }),
  ]);
  const pushEnabled = new Map(users.map((user) => {
    const prefs = user.notificationPrefs as { push?: boolean } | null;
    return [user.id, prefs?.push !== false] as const;
  }));
  const tokensByUser = new Map<string, string[]>();
  for (const token of tokens) {
    const current = tokensByUser.get(token.userId) ?? [];
    current.push(token.token);
    tokensByUser.set(token.userId, current);
  }
  const push = runtime.channels?.push ?? getChannels().push;
  await Promise.all(notifications.map(async (notification) => {
    if (!pushEnabled.get(notification.userId)) return;
    const deviceTokens = tokensByUser.get(notification.userId) ?? [];
    if (deviceTokens.length === 0) return;
    const rawData = notification.data && typeof notification.data === 'object' && !Array.isArray(notification.data)
      ? notification.data as Record<string, unknown>
      : {};
    const result = await push.sendPush(
      deviceTokens,
      notification.title,
      notification.body,
      { ...rawData, notificationId: notification.id },
    );
    if (result.invalidTokens?.length) {
      await runtime.prisma.deviceToken.updateMany({
        where: { token: { in: result.invalidTokens } },
        data: { isActive: false },
      }).catch((error) => runtime.log.warn(
        { err: error, notificationId: notification.id },
        'mover revocation invalid push-token cleanup failed',
      ));
    }
  }));
}

async function applyOutboxEffects(
  runtime: MoverRevocationOutboxRuntime,
  row: ClaimedOutboxRow,
): Promise<void> {
  const payload = parsePayload(row.payload);

  if (payload.riderId) {
    await runtime.dispatch.releaseHeldOffer(payload.riderId);
    // closeOnlineSession is a Redis-side atomic fold+delete, so replay after a
    // worker crash cannot count the same online interval twice.
    await closeOnlineSession(runtime.redis, payload.riderId);
  }
  if (payload.driverId) {
    await runtime.dispatch.releaseHeldOffer(payload.driverId);
  }

  for (const order of payload.orders) {
    if (order.action === 'REDISPATCH') {
      await runtime.dispatch.retryDispatch(order.orderId);
      runtime.io.to(`order:${order.orderId}`).emit('order:status_changed', {
        eventId: `${row.id}:${order.orderId}`,
        orderId: order.orderId,
        status: order.status,
        reason: 'mover_session_ended',
        timestamp: new Date().toISOString(),
      });
    } else {
      let incidentMetadata: { category: string; severity: string } | null = null;
      if (order.incidentId) {
        // Evidence capture is outside the authority transaction because it
        // snapshots multiple operational tables. It is still durable: any
        // failure leaves this outbox row unprocessed, and openForCase is
        // idempotent when a crash occurs after bundle creation.
        await new EvidenceService(runtime.prisma, runtime.io).openForCase(order.incidentId);
        // Pattern escalation is decided transactionally at intake. Read that
        // durable result for realtime fan-out rather than assuming every
        // custody-loss case stayed at its first-event S1 default.
        incidentMetadata = await runtime.prisma.incidentCase.findUniqueOrThrow({
          where: { id: order.incidentId },
          select: { category: true, severity: true },
        });
      }
      runtime.io.to(`order:${order.orderId}`).emit('order:mover_connection_lost', {
        eventId: `${row.id}:${order.orderId}`,
        orderId: order.orderId,
        status: order.status,
        timestamp: new Date().toISOString(),
      });
      if (order.incidentId && incidentMetadata) {
        runtime.io.to('ops:war-room').emit('incident:new', {
          eventId: `${row.id}:${order.orderId}`,
          caseId: order.incidentId,
          category: incidentMetadata.category,
          orderId: order.orderId,
          severity: incidentMetadata.severity,
        });
      }
    }
  }
  await emitDurableNotifications(runtime, payload);
}

async function markClaimProcessed(
  runtime: MoverRevocationOutboxRuntime,
  row: ClaimedOutboxRow,
): Promise<boolean> {
  const completed = await runtime.prisma.$executeRaw`
    UPDATE "mover_revocation_outbox"
    SET "processedAt" = CURRENT_TIMESTAMP,
        "claimedAt" = NULL,
        "lastError" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id}
      AND "processedAt" IS NULL
      AND "claimedAt" = ${row.claimedAt}
  `;
  return completed === 1;
}

async function releaseClaimForRetry(
  runtime: MoverRevocationOutboxRuntime,
  row: ClaimedOutboxRow,
  error: unknown,
): Promise<number> {
  const delayMs = retryDelayMs(row.attempts);
  const lastError = errorMessage(error);
  await runtime.prisma.$executeRaw`
    UPDATE "mover_revocation_outbox"
    SET "claimedAt" = NULL,
        "availableAt" = CURRENT_TIMESTAMP + (${delayMs} * INTERVAL '1 millisecond'),
        "lastError" = ${lastError},
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id}
      AND "processedAt" IS NULL
      AND "claimedAt" = ${row.claimedAt}
  `;
  return delayMs;
}

async function preserveTimedOutClaimLease(
  runtime: MoverRevocationOutboxRuntime,
  row: ClaimedOutboxRow,
  error: unknown,
): Promise<number> {
  const delayMs = retryDelayMs(row.attempts);
  const retryAfterMs = claimLeaseMs() + delayMs;
  const lastError = errorMessage(error);
  // withTimeout cannot cancel an arbitrary provider/Redis/dispatch promise.
  // Keep this generation's claim fenced while that promise is still alive;
  // clearing claimedAt here would let an immediate sweep run the same external
  // effects concurrently. A process crash still becomes reclaimable after the
  // original lease, with normal retry backoff added to availableAt.
  await runtime.prisma.$executeRaw`
    UPDATE "mover_revocation_outbox"
    SET "availableAt" = GREATEST(
          "availableAt",
          ${row.claimedAt} + (${retryAfterMs} * INTERVAL '1 millisecond')
        ),
        "lastError" = ${lastError},
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${row.id}
      AND "processedAt" IS NULL
      AND "claimedAt" = ${row.claimedAt}
  `;
  return delayMs;
}

async function processClaimedOutboxRow(
  runtime: MoverRevocationOutboxRuntime,
  row: ClaimedOutboxRow,
): Promise<boolean> {
  const timeoutMs = effectTimeoutMs();
  const timeoutLabel = `Mover revocation outbox ${row.id} effects`;
  const effects = applyOutboxEffects(runtime, row);
  try {
    await withTimeout(
      effects,
      timeoutMs,
      timeoutLabel,
    );
    if (await markClaimProcessed(runtime, row)) {
      runtime.log.info({ outboxId: row.id, attempts: row.attempts }, 'mover revocation outbox processed');
      return true;
    }
    return false;
  } catch (error) {
    const timedOut = error instanceof Error
      && error.message === `${timeoutLabel} timed out after ${timeoutMs}ms`;
    const delayMs = timedOut
      ? await preserveTimedOutClaimLease(runtime, row, error)
      : await releaseClaimForRetry(runtime, row, error);

    if (timedOut) {
      // The operation may settle after Promise.race timed out. Keep observing
      // it and finalize only if this exact claim generation still owns the row.
      // If the process dies, or it remains hung beyond the full lease, the
      // recurring worker retains the normal stale-claim recovery path.
      void effects.then(async () => {
        if (await markClaimProcessed(runtime, row)) {
          runtime.log.info(
            { outboxId: row.id, attempts: row.attempts },
            'timed-out mover revocation effects completed within the claim lease',
          );
        }
      }, async (lateError) => {
        const lateDelayMs = await releaseClaimForRetry(runtime, row, lateError);
        runtime.log.warn(
          { err: lateError, outboxId: row.id, attempts: row.attempts, retryInMs: lateDelayMs },
          'timed-out mover revocation effects later failed; retry scheduled',
        );
      }).catch((settlementError) => runtime.log.error(
        { err: settlementError, outboxId: row.id, attempts: row.attempts },
        'timed-out mover revocation claim settlement failed',
      ));
    }
    runtime.log.warn(
      { err: error, outboxId: row.id, attempts: row.attempts, retryInMs: delayMs, claimLeasePreserved: timedOut },
      timedOut
        ? 'mover revocation outbox delivery timed out; claim fenced until its lease expires'
        : 'mover revocation outbox delivery failed; retry scheduled',
    );
    throw error;
  }
}

/** Immediate post-commit delivery. A crash before/inside/after this call leaves
 * the durable row unprocessed or lease-reclaimable for the recurring worker. */
export async function processMoverRevocationOutboxById(
  runtime: MoverRevocationOutboxRuntime,
  outboxId: string,
): Promise<boolean> {
  const row = await claimNextOutboxRow(runtime.prisma, { id: outboxId });
  if (!row) return false;
  return processClaimedOutboxRow(runtime, row);
}

/** SKIP LOCKED lets every worker instance participate without double-owning a
 * live claim. Stale claims are deliberately reclaimable after the lease. */
export async function processMoverRevocationOutboxBatch(
  runtime: MoverRevocationOutboxRuntime,
  limit = 25,
): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < Math.max(1, limit); i += 1) {
    const row = await claimNextOutboxRow(runtime.prisma);
    if (!row) break;
    try {
      if (await processClaimedOutboxRow(runtime, row)) processed += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}
