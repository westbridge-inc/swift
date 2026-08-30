import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { algoConfig } from '../algo/algo-config';
import { recordDecision } from '../algo/decisions';
import { predictReady, bucketOf, percentile, AGGREGATE_BUCKET, type PrepTier } from '../prep/prep-time';
import { estimateDeliveryMinutes } from '../../utils/distance';
import type { NotificationService } from '../notification/notification.service';
import { log } from '../../utils/logger';

/**
 * [ALG-12 / FMC-01 §12.2] The customer's ETA promise, padded against
 * Swift's OWN late rate.
 *
 *   promise = prep(p80, ALG-03) + riderToStore + service + riderToCustomer + pad
 *   pad     = the lateness a vertical-hour actually produced, chosen so the
 *             realised on-time rate lands on `eta.targetOnTime` (0.85) —
 *             measured weekly from delivered orders, never assumed.
 *
 * Laws:
 *   L8  the promise is WRITTEN ONTO THE ORDER at creation and never silently
 *       revised — a revision tells the customer and records its reason.
 *   L7  a countdown reads the promise, never the live ETA; the live ETA's
 *       only power over the promise is to REVISE it, out loud, when it slips
 *       past by `eta.slipNotifySeconds` (R-12.2.2/3).
 *   R-12.2.1 the customer sees a RANGE, [promise − 5, promise + 10] on
 *       five-minute marks — never "arriving at 7:42".
 *   Report the realised rate every week: a promise nobody measures is a lie
 *       nobody has noticed yet.
 *
 * Zones (ALG-14) do not exist yet, so the pad is learned per VERTICAL and
 * HOUR (America/Guyana) tenant-wide; the moment zones exist the key gains a
 * zone. Registered, not hidden.
 */

export const ALGO_ID = 'ALG-12';
export const WINDOW_BEFORE_MIN = 5;
export const WINDOW_AFTER_MIN = 10;
export const WINDOW_MARK_MIN = 5;
export const PAD_LEARN_WINDOW_DAYS = 28;
/** A slip notice fires at most once per order per this many seconds. */
export const SLIP_GATE_SECONDS = 600;

export type PadSource = 'HOUR' | 'VERTICAL' | 'DEFAULT';

export interface PromiseParts {
  prepP80Seconds: number;
  prepTier: PrepTier;
  riderToStoreSeconds: number;
  serviceSeconds: number;
  toCustomerSeconds: number;
  padSeconds: number;
  padSource: PadSource;
}

export interface PromiseResult {
  promisedAt: Date;
  baseSeconds: number;
  padSeconds: number;
  parts: PromiseParts;
}

// ---------------------------------------------------------------------------
// The range the customer sees
// ---------------------------------------------------------------------------

const MARK_MS = WINDOW_MARK_MIN * 60_000;

/** [R-12.2.1] A range on five-minute marks: start rounded down, end rounded up. */
export function promiseWindow(promisedAt: Date): { start: Date; end: Date } {
  const start = Math.floor((promisedAt.getTime() - WINDOW_BEFORE_MIN * 60_000) / MARK_MS) * MARK_MS;
  const end = Math.ceil((promisedAt.getTime() + WINDOW_AFTER_MIN * 60_000) / MARK_MS) * MARK_MS;
  return { start: new Date(start), end: new Date(end) };
}

export interface PromiseView {
  at: string;
  windowStart: string;
  windowEnd: string;
  revisedAt: string | null;
  revisionReason: string | null;
  revisions: number;
}

/** What every read hands the client: the promise, its range, and whether it moved. */
export function promiseView(order: {
  promisedAt: Date | null;
  promiseRevisedAt?: Date | null;
  promiseRevisionReason?: string | null;
  promiseRevisions?: number | null;
}): PromiseView | null {
  if (!order.promisedAt) return null;
  const w = promiseWindow(order.promisedAt);
  return {
    at: order.promisedAt.toISOString(),
    windowStart: w.start.toISOString(),
    windowEnd: w.end.toISOString(),
    revisedAt: order.promiseRevisedAt?.toISOString() ?? null,
    revisionReason: order.promiseRevisionReason ?? null,
    revisions: order.promiseRevisions ?? 0,
  };
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guyana', hour: 'numeric', minute: '2-digit', hour12: true });
export function windowSentence(w: { start: Date; end: Date }): string {
  return `between ${timeFmt.format(w.start)} and ${timeFmt.format(w.end)}`;
}

// ---------------------------------------------------------------------------
// The pad
// ---------------------------------------------------------------------------

async function padFor(prisma: PrismaClient, tenantId: string, vertical: string, at: Date): Promise<{ padSeconds: number; padSource: PadSource; version: number }> {
  const dflt = await algoConfig(prisma, 'eta.defaultPadSeconds');
  const { hourBucket } = bucketOf(at);
  const rows = await prisma.etaPadStat.findMany({
    where: { tenantId, vertical, OR: [{ hourBucket }, { hourBucket: AGGREGATE_BUCKET }] },
  });
  const hour = rows.find((r) => r.hourBucket === hourBucket);
  if (hour) return { padSeconds: hour.padSeconds, padSource: 'HOUR', version: dflt.version };
  const overall = rows.find((r) => r.hourBucket === AGGREGATE_BUCKET);
  if (overall) return { padSeconds: overall.padSeconds, padSource: 'VERTICAL', version: dflt.version };
  return { padSeconds: Math.max(0, Number(dflt.value) || 0), padSource: 'DEFAULT', version: dflt.version };
}

// ---------------------------------------------------------------------------
// The promise, at checkout
// ---------------------------------------------------------------------------

export interface PromiseInput {
  tenantId: string;
  /** The order's vertical — the pad's key until zones exist. */
  orderType: string;
  vendorId: string;
  vendorType: string;
  declaredMinutes: number | null;
  distanceKm: number;
  itemCount: number;
  placedAt: Date;
}

export async function promiseAtCheckout(prisma: PrismaClient, input: PromiseInput): Promise<PromiseResult> {
  const [riderToStore, service] = await Promise.all([
    algoConfig(prisma, 'eta.riderToStoreSeconds'),
    algoConfig(prisma, 'eta.serviceTimeSeconds'),
  ]);
  const prep = await predictReady(prisma, {
    vendorId: input.vendorId, vendorType: input.vendorType, declaredMinutes: input.declaredMinutes,
    at: input.placedAt, itemCount: input.itemCount, tenantId: input.tenantId,
  });
  const toCustomerSeconds = estimateDeliveryMinutes(Math.max(0, input.distanceKm)) * 60;
  const parts: Omit<PromiseParts, 'padSeconds' | 'padSource'> = {
    prepP80Seconds: prep.p80Seconds,
    prepTier: prep.tier,
    riderToStoreSeconds: Math.max(0, Number(riderToStore.value) || 0),
    serviceSeconds: Math.max(0, Number(service.value) || 0),
    toCustomerSeconds,
  };
  const baseSeconds = parts.prepP80Seconds + parts.riderToStoreSeconds + parts.serviceSeconds + parts.toCustomerSeconds;
  const pad = await padFor(prisma, input.tenantId, input.orderType, input.placedAt);
  return {
    promisedAt: new Date(input.placedAt.getTime() + (baseSeconds + pad.padSeconds) * 1000),
    baseSeconds,
    padSeconds: pad.padSeconds,
    parts: { ...parts, padSeconds: pad.padSeconds, padSource: pad.padSource },
  };
}

// ---------------------------------------------------------------------------
// Revision — out loud, with the reason recorded (L8)
// ---------------------------------------------------------------------------

export interface PromiseDeps {
  prisma: PrismaClient;
  io: Server;
  notifications: NotificationService;
}

export async function revisePromise(
  deps: PromiseDeps,
  input: { orderId: string; newPromisedAt: Date; reason: string; source: 'LIVE_ETA' | 'VENDOR' | 'OPS'; now?: Date },
): Promise<{ revised: boolean; minutesLate: number }> {
  const now = input.now ?? new Date();
  const order = await deps.prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true, customerId: true, orderNumber: true, status: true, promisedAt: true, promiseRevisions: true, tenantId: true },
  });
  if (!order?.promisedAt) return { revised: false, minutesLate: 0 };
  const slipSeconds = (input.newPromisedAt.getTime() - order.promisedAt.getTime()) / 1000;
  // Only a slip revises. Earlier-than-promised is simply delivered early.
  if (slipSeconds <= 0) return { revised: false, minutesLate: 0 };
  const minutesLate = Math.max(1, Math.round(slipSeconds / 60));

  await deps.prisma.order.update({
    where: { id: order.id },
    data: {
      promisedAt: input.newPromisedAt,
      promiseRevisedAt: now,
      promiseRevisionReason: input.reason,
      promiseRevisions: { increment: 1 },
      estimatedDeliveryTime: Math.max(1, Math.round((input.newPromisedAt.getTime() - now.getTime()) / 60_000)),
    },
  });
  const w = promiseWindow(input.newPromisedAt);
  await recordDecision(deps.prisma, {
    algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId, outcome: 'REVISED',
    sentence: `The promise moved ${minutesLate} min later, to ${windowSentence(w)}: ${input.reason}.`,
    inputs: {
      from: order.promisedAt.toISOString(), to: input.newPromisedAt.toISOString(), minutesLate,
      reason: input.reason, source: input.source, revision: (order.promiseRevisions ?? 0) + 1, status: order.status,
    },
  });
  await deps.notifications.orderRunningLate(order.customerId, order.orderNumber, order.id, minutesLate, w, order.status);
  deps.io.to(`order:${order.id}`).emit('order:promise_revised', {
    orderId: order.id, promisedAt: input.newPromisedAt.toISOString(), windowStart: w.start.toISOString(), windowEnd: w.end.toISOString(),
    reason: input.reason, minutesLate,
  });
  return { revised: true, minutesLate };
}

/** Statuses whose live ETA is to the CUSTOMER — the only ones a slip can be judged from. */
export const SLIP_JUDGEABLE_STATUSES = new Set(['PICKED_UP', 'EN_ROUTE_DELIVERY']);

/**
 * [R-12.2.2/3] A live ETA that lands past the promise by the threshold
 * revises the promise — once per order per SLIP_GATE_SECONDS — and tells the
 * customer before they check. Fire-and-forget; never throws.
 */
export async function noteLiveEta(
  deps: PromiseDeps & { redis: Redis },
  leg: { orderId: string; status: string; etaMinutes: number | null; basis: 'direct' | 'after_current'; now?: Date },
): Promise<{ revised: boolean }> {
  try {
    if (leg.basis !== 'direct' || leg.etaMinutes == null || !SLIP_JUDGEABLE_STATUSES.has(leg.status)) return { revised: false };
    const now = leg.now ?? new Date();
    const order = await deps.prisma.order.findUnique({ where: { id: leg.orderId }, select: { promisedAt: true } });
    if (!order?.promisedAt) return { revised: false };
    const projected = new Date(now.getTime() + leg.etaMinutes * 60_000);
    const threshold = Number((await algoConfig(deps.prisma, 'eta.slipNotifySeconds')).value) || 300;
    if ((projected.getTime() - order.promisedAt.getTime()) / 1000 < threshold) return { revised: false };
    const gate = await deps.redis.set(`eta:slip:${leg.orderId}`, '1', 'EX', SLIP_GATE_SECONDS, 'NX');
    if (gate !== 'OK') return { revised: false };
    const r = await revisePromise(deps, {
      orderId: leg.orderId, newPromisedAt: projected, source: 'LIVE_ETA', now,
      reason: `the rider’s live ETA runs ${Math.max(1, Math.round((projected.getTime() - order.promisedAt.getTime()) / 60_000))} min past the promise`,
    });
    return { revised: r.revised };
  } catch (err) {
    log().warn({ err, orderId: leg.orderId }, 'eta-promise: slip check failed');
    return { revised: false };
  }
}

// ---------------------------------------------------------------------------
// Learn the pad (weekly) and report the realised rate
// ---------------------------------------------------------------------------

export async function computeEtaPads(prisma: PrismaClient, now = new Date(), days = PAD_LEARN_WINDOW_DAYS): Promise<{ orders: number; rows: number; pruned: number }> {
  const target = Number((await algoConfig(prisma, 'eta.targetOnTime')).value) || 0.85;
  const since = new Date(now.getTime() - days * 86_400_000);
  const orders = await prisma.order.findMany({
    where: { deliveredAt: { gte: since, not: null }, promiseBaseSeconds: { not: null }, orderType: { not: 'TAXI' } },
    select: { tenantId: true, orderType: true, placedAt: true, deliveredAt: true, promiseBaseSeconds: true },
  });
  type Group = { tenantId: string; vertical: string; hourBucket: number; lateness: number[] };
  const groups = new Map<string, Group>();
  const add = (tenantId: string, vertical: string, hourBucket: number, late: number) => {
    const key = `${tenantId}|${vertical}|${hourBucket}`;
    const g = groups.get(key);
    if (g) g.lateness.push(late);
    else groups.set(key, { tenantId, vertical, hourBucket, lateness: [late] });
  };
  for (const o of orders) {
    if (!o.deliveredAt || o.promiseBaseSeconds == null) continue;
    const late = (o.deliveredAt.getTime() - o.placedAt.getTime()) / 1000 - o.promiseBaseSeconds;
    add(o.tenantId, o.orderType, bucketOf(o.placedAt).hourBucket, late);
    add(o.tenantId, o.orderType, AGGREGATE_BUCKET, late);
  }
  const startedAt = now;
  let rows = 0;
  for (const g of groups.values()) {
    const sorted = [...g.lateness].sort((a, b) => a - b);
    const padSeconds = Math.max(0, Math.round(percentile(sorted, target)));
    const onTimeRate = Math.round((sorted.filter((l) => l <= 0).length / sorted.length) * 100) / 100;
    const data = { sampleCount: sorted.length, onTimeRate, padSeconds, lastComputedAt: startedAt };
    await prisma.etaPadStat.upsert({
      where: { tenantId_vertical_hourBucket: { tenantId: g.tenantId, vertical: g.vertical, hourBucket: g.hourBucket } },
      create: { tenantId: g.tenantId, vertical: g.vertical, hourBucket: g.hourBucket, ...data },
      update: data,
    });
    rows += 1;
  }
  const pruned = await prisma.etaPadStat.deleteMany({ where: { lastComputedAt: { lt: startedAt } } });
  return { orders: orders.length, rows, pruned: pruned.count };
}

export interface EtaReport {
  days: number;
  promised: number;
  delivered: number;
  realisedOnTimeRate: number | null;
  medianLateMinutes: number | null;
  revisedShare: number | null;
  target: number;
  byVertical: Record<string, { delivered: number; onTimeRate: number | null }>;
  pads: Array<{ vertical: string; hourBucket: number; sampleCount: number; onTimeRate: number; padSeconds: number }>;
}

/** The founder's weekly answer: did we keep the promises we made? */
export async function etaReport(prisma: PrismaClient, days = PAD_LEARN_WINDOW_DAYS, now = new Date()): Promise<EtaReport> {
  const target = Number((await algoConfig(prisma, 'eta.targetOnTime')).value) || 0.85;
  const since = new Date(now.getTime() - days * 86_400_000);
  const promised = await prisma.order.count({ where: { placedAt: { gte: since }, promisedAt: { not: null } } });
  const delivered = await prisma.order.findMany({
    where: { placedAt: { gte: since }, promisedAt: { not: null }, deliveredAt: { not: null } },
    select: { orderType: true, promisedAt: true, deliveredAt: true, promiseRevisions: true },
  });
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const late = delivered.map((o) => (o.deliveredAt!.getTime() - o.promisedAt!.getTime()) / 60_000);
  const onTime = late.filter((m) => m <= 0).length;
  const byVertical: EtaReport['byVertical'] = {};
  for (const o of delivered) {
    const v = byVertical[o.orderType] ?? { delivered: 0, onTimeRate: null };
    v.delivered += 1;
    byVertical[o.orderType] = v;
  }
  for (const [vertical, v] of Object.entries(byVertical)) {
    const rows = delivered.filter((o) => o.orderType === vertical);
    v.onTimeRate = round2(rows.filter((o) => o.deliveredAt!.getTime() <= o.promisedAt!.getTime()).length / rows.length);
  }
  const pads = await prisma.etaPadStat.findMany({ orderBy: [{ vertical: 'asc' }, { hourBucket: 'asc' }], select: { vertical: true, hourBucket: true, sampleCount: true, onTimeRate: true, padSeconds: true } });
  return {
    days, promised, delivered: delivered.length,
    realisedOnTimeRate: delivered.length ? round2(onTime / delivered.length) : null,
    medianLateMinutes: delivered.length ? round2(percentile([...late].sort((a, b) => a - b), 0.5)) : null,
    revisedShare: delivered.length ? round2(delivered.filter((o) => (o.promiseRevisions ?? 0) > 0).length / delivered.length) : null,
    target, byVertical, pads,
  };
}

/** The weekly job: relearn the pads, then write the founder's row. */
export async function weeklyEtaCalibration(prisma: PrismaClient, now = new Date()): Promise<EtaReport & { learned: { orders: number; rows: number; pruned: number } }> {
  const learned = await computeEtaPads(prisma, now);
  const report = await etaReport(prisma, PAD_LEARN_WINDOW_DAYS, now);
  const rate = report.realisedOnTimeRate;
  await recordDecision(prisma, {
    algo: ALGO_ID, subjectType: 'VENDOR', subjectId: 'platform', outcome: rate == null ? 'NO_DATA' : rate >= report.target ? 'ON_TARGET' : 'BELOW_TARGET',
    sentence: rate == null
      ? `Over ${report.days} days, ${report.promised} promises made and none delivered yet — nothing to measure.`
      : `Over ${report.days} days, ${report.delivered} promises kept ${Math.round(rate * 100)}% of the time against a ${Math.round(report.target * 100)}% target; ${Math.round((report.revisedShare ?? 0) * 100)}% were revised out loud.`,
    inputs: { ...report, learned },
    shadow: true,
  });
  return { ...report, learned };
}
