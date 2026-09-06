/**
 * [DOC-1 §31.4 · DOC-INV-47 · P31-1] Rider Loss Protection — the promise, written, funded and capped.
 *
 * Below the ID gate the rider fronts the food cost out of his own pocket, and when the
 * customer bails at the door Swift covers the loss. §31.4 says that promise must be a
 * POLICY, not a sentence: covered amount and cap per claim (the gate), a cap per rider
 * per rolling 30 days, a pay-out SLA, a named reserve line provisioned from fee revenue,
 * and — DOC-INV-47 — no payout without a complete evidence bundle assembled from the
 * artefacts the platform already holds, never typed by the rider.
 *
 * This file is the ONE author of: the evidence bundle, the reserve ledger (balance,
 * draw, provisioning) and the daily sweep. cash-rules.service.ts files and pays claims
 * and calls in here; nothing else re-expresses any of it.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { haversineDistance } from '../../utils/distance';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Policy tunables — merged into CashRulesConfig (CountryConfig.cashRules overrides).
// Expressed RELATIVE to the ID gate so they carry the gate's USD anchor and need no
// second currency constant (FD-DOC-30 defaults, delegated ruling 2026-09-06).
// ---------------------------------------------------------------------------
export interface LossProtectionRules {
  /** Cap per rider per rolling 30 days, as a multiple of the ID gate (2 = twice the gate). */
  rlpMonthlyCapMultiple: number;
  /** Every claim above this fraction of the gate is human-reviewed with the full bundle. */
  rlpReviewFraction: number;
  /** Pay-out SLA: an approved claim unpaid for longer is flagged and the admins told. */
  rlpSlaHours: number;
  /** Monthly provisioning: this percentage of the previous month's paid fee revenue. */
  rlpReserveRatePct: number;
  /** The reserve is "low" below this multiple of the gate; the sweep says so. */
  rlpReserveFloorMultiple: number;
}

export const LOSS_PROTECTION_DEFAULTS: LossProtectionRules = {
  rlpMonthlyCapMultiple: 2,
  rlpReviewFraction: 0.5,
  rlpSlaHours: 48,
  rlpReserveRatePct: 2,
  rlpReserveFloorMultiple: 5,
};

/** The guardrail flags this policy adds to a claim (the fraud flags live in cash-rules). */
export const LOSS_PROTECTION_FLAGS = {
  overMonthlyCap: 'over_monthly_cap',
  overReviewThreshold: 'over_review_threshold',
  protectionSuspended: 'protection_suspended',
  evidenceIncomplete: 'evidence_incomplete',
  slaBreached: 'sla_breached',
} as const;

export const ROLLING_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Covered amount — §31.3/§31.4: the rider's FRONTED cost, not the order total.
// ---------------------------------------------------------------------------

/**
 * What the policy covers. On the delivery rails the rider paid the vendor the food
 * cost at pickup — that is the exposure; the delivery fee is his earnings, not his
 * stake. A taxi fare or courier fee was earned by a service already rendered and
 * nothing was fronted, so the guarantee covers the fare/fee as it always has.
 */
export function coveredAmountFor(order: { orderType: string; subtotalBase: unknown; totalAmount: unknown }): number {
  return isDeliveryRail(order.orderType) ? Number(order.subtotalBase) : Number(order.totalAmount);
}

export function isDeliveryRail(orderType: string): boolean {
  return orderType === 'FOOD_DELIVERY' || orderType === 'GROCERY_DELIVERY';
}

// ---------------------------------------------------------------------------
// The evidence bundle — DOC-INV-47
// ---------------------------------------------------------------------------

export type EvidenceKey =
  | 'handover_not_completed'
  | 'rider_at_door'
  | 'customer_contacted'
  | 'door_photo'
  | 'pickup_proof'
  | 'cart_snapshot';

export interface EvidenceItem {
  key: EvidenceKey;
  present: boolean;
  required: boolean;
  /** Where the artefact comes from — the spec's table, so a reviewer knows what to open. */
  source: string;
  detail?: Record<string, unknown>;
}

export interface ClaimEvidence {
  rail: 'DELIVERY' | 'COURIER' | 'TAXI';
  items: EvidenceItem[];
  missing: EvidenceKey[];
  complete: boolean;
  assembledAt: string;
}

/**
 * Which artefacts a rail can produce. `customer_contacted` is reported but NOT
 * required on day one: the only automatic artefact is in-app chat, and a rider who
 * phoned the customer directly leaves none — requiring it would refuse honest claims.
 * It becomes required when the masked-call rail exists (deferred clause, register).
 */
export function requiredEvidenceFor(rail: ClaimEvidence['rail']): EvidenceKey[] {
  if (rail === 'DELIVERY') return ['handover_not_completed', 'rider_at_door', 'door_photo', 'pickup_proof', 'cart_snapshot'];
  if (rail === 'COURIER') return ['handover_not_completed', 'rider_at_door', 'door_photo'];
  return ['rider_at_door'];
}

export interface ClaimForEvidence {
  id?: string;
  orderId: string;
  riderId: string | null;
  driverId: string | null;
  gpsLat: number;
  gpsLng: number;
  photoUrl: string | null;
  createdAt: Date;
}

/**
 * Assemble the bundle from artefacts — the order row, its status log, the chat room,
 * the cart — as they stand NOW. Called at filing (stored on the claim for the reviewer)
 * and again at payout (the source of truth; a stored copy could be stale or edited).
 */
export async function assembleClaimEvidence(
  db: Db,
  claim: ClaimForEvidence,
  opts: { maxHandoverDistanceKm: number },
): Promise<ClaimEvidence> {
  const order = await db.order.findUnique({
    where: { id: claim.orderId },
    select: {
      orderType: true, status: true, deliveredAt: true, deliveryLat: true, deliveryLng: true, courierProofPhotoUrl: true,
      _count: { select: { items: true } },
    },
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'The claim names an order that does not exist.');
  const rail: ClaimEvidence['rail'] = order.orderType === 'TAXI' ? 'TAXI' : order.orderType === 'COURIER' ? 'COURIER' : 'DELIVERY';
  const filedAt = claim.createdAt;
  const logs = await db.orderStatusLog.findMany({
    where: { orderId: claim.orderId, status: { in: ['ARRIVED', 'PICKED_UP'] }, createdAt: { lte: filedAt } },
    select: { status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const arrival = logs.find((l) => l.status === 'ARRIVED');
  const pickup = logs.find((l) => l.status === 'PICKED_UP');
  const distanceKm = order.deliveryLat != null && order.deliveryLng != null
    ? haversineDistance(claim.gpsLat, claim.gpsLng, order.deliveryLat, order.deliveryLng)
    : null;
  const withinRadius = distanceKm != null && distanceKm <= opts.maxHandoverDistanceKm;
  const dwellMinutes = arrival ? Math.max(0, Math.round((filedAt.getTime() - arrival.createdAt.getTime()) / 60_000)) : null;

  // The mover's own messages on the order's chat room, before the claim.
  const moverUserId = await moverUserIdOf(db, claim);
  const contacted = moverUserId
    ? await db.chatMessage.count({ where: { chatRoom: { orderId: claim.orderId }, senderId: moverUserId, createdAt: { lte: filedAt } } })
    : 0;

  const required = new Set(requiredEvidenceFor(rail));
  const item = (key: EvidenceKey, present: boolean, source: string, detail?: Record<string, unknown>): EvidenceItem =>
    ({ key, present, required: required.has(key), source, ...(detail ? { detail } : {}) });
  const items: EvidenceItem[] = [
    item('handover_not_completed', order.deliveredAt == null && order.status !== 'DELIVERED', 'order row: never delivered, no handover completed', { status: order.status }),
    // A taxi has no ARRIVED row at the destination (the fare outcome is recorded with the
    // passenger aboard) and a courier job is closed from custody at the drop-off — on those
    // rails the artefact is the mover's GPS at the drop-off point. A delivery marks ARRIVED.
    item('rider_at_door', (rail !== 'DELIVERY' || Boolean(arrival)) && withinRadius, rail === 'DELIVERY' ? 'status log ARRIVED + claim GPS within the handover radius of the delivery point' : 'claim GPS within the handover radius of the drop-off point',
      { arrivedAt: arrival?.createdAt.toISOString() ?? null, dwellMinutes, distanceM: distanceKm == null ? null : Math.round(distanceKm * 1000) }),
    item('customer_contacted', contacted > 0, 'in-app chat messages from the mover on this order (a direct phone call leaves no artefact)', { messages: contacted }),
    item('door_photo', Boolean(claim.photoUrl ?? (rail === 'COURIER' ? order.courierProofPhotoUrl : null)), 'photo taken at the door by the mover app'),
    item('pickup_proof', Boolean(pickup), 'status log PICKED_UP — the rider took custody, having paid the vendor', { pickedUpAt: pickup?.createdAt.toISOString() ?? null }),
    item('cart_snapshot', order._count.items > 0, 'order items as placed', { items: order._count.items }),
  ];
  const missing = items.filter((i) => i.required && !i.present).map((i) => i.key);
  return { rail, items, missing, complete: missing.length === 0, assembledAt: new Date().toISOString() };
}

async function moverUserIdOf(db: Db, claim: { riderId: string | null; driverId: string | null }): Promise<string | null> {
  if (claim.riderId) return (await db.rider.findUnique({ where: { id: claim.riderId }, select: { userId: true } }))?.userId ?? null;
  if (claim.driverId) return (await db.driver.findUnique({ where: { id: claim.driverId }, select: { userId: true } }))?.userId ?? null;
  return null;
}

/** The payout gate, in one place: an incomplete bundle refuses the payout and says what is missing. */
export function assertEvidenceComplete(evidence: ClaimEvidence): void {
  if (evidence.complete) return;
  throw new AppError(
    409,
    'RLP_EVIDENCE_INCOMPLETE',
    `The loss-protection payout needs a complete evidence bundle; missing: ${evidence.missing.join(', ')}. The reviewer decides with the bundle — nobody pays without it.`,
  );
}

// ---------------------------------------------------------------------------
// Rolling-window exposure — the cap per rider per 30 days
// ---------------------------------------------------------------------------

/** What this mover has already claimed in the rolling window — every claim not rejected counts against the cap. */
export async function rollingClaimTotal(
  db: Db,
  mover: { riderId: string | null; driverId: string | null },
  now: Date,
  windowDays = ROLLING_WINDOW_DAYS,
): Promise<number> {
  const mine = mover.riderId ? { riderId: mover.riderId } : { driverId: mover.driverId };
  const agg = await db.reimbursementClaim.aggregate({
    _sum: { amount: true },
    where: { ...mine, status: { not: 'REJECTED' }, createdAt: { gte: new Date(now.getTime() - windowDays * DAY_MS) } },
  });
  return Number(agg._sum.amount ?? 0);
}

// ---------------------------------------------------------------------------
// The reserve — a named liability line per country
// ---------------------------------------------------------------------------

export async function reserveBalance(db: Db, countryCode: string): Promise<number> {
  const agg = await db.rlpReserveEntry.aggregate({ _sum: { amount: true }, where: { countryCode } });
  return Number(agg._sum.amount ?? 0);
}

/**
 * Draw one claim's payout from the reserve, INSIDE the payout transaction. Serialised
 * per country by the same advisory lock the trigger takes, so two payouts cannot both
 * read the same balance; refused with a 409 that says the shortfall when the line is
 * short. The trigger is the backstop for any write that bypasses this function.
 */
export async function drawReserveForPayout(
  tx: Prisma.TransactionClient,
  input: { countryCode: string; claimId: string; amount: number; byId: string },
): Promise<{ balanceAfter: number }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rlp_reserve:' + input.countryCode}))`;
  const balance = await reserveBalance(tx, input.countryCode);
  if (balance < input.amount) {
    throw new AppError(
      409,
      'RLP_RESERVE_UNFUNDED',
      `The ${input.countryCode} loss-protection reserve holds ${balance.toLocaleString()} against a ${input.amount.toLocaleString()} payout. Provision the reserve line first — a claim is paid from it or not at all.`,
    );
  }
  try {
    await tx.rlpReserveEntry.create({ data: {
      countryCode: input.countryCode, kind: 'PAYOUT', amount: -input.amount, claimId: input.claimId, createdById: input.byId, note: `payout of claim ${input.claimId}`,
    } });
  } catch (err) {
    if (isReserveUnfundedError(err)) {
      throw new AppError(409, 'RLP_RESERVE_UNFUNDED', `The ${input.countryCode} loss-protection reserve cannot cover this payout.`);
    }
    throw err;
  }
  return { balanceAfter: balance - input.amount };
}

export function isReserveUnfundedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('RLP_RESERVE_UNFUNDED');
}

/** An audited manual entry: a top-up, or a correction. Negative adjustments face the same floor as a payout. */
export async function adjustReserve(
  tx: Prisma.TransactionClient,
  input: { countryCode: string; amount: number; byId: string; note: string },
): Promise<{ id: string; balanceAfter: number }> {
  if (!Number.isFinite(input.amount) || input.amount === 0) throw new AppError(400, 'RLP_AMOUNT_INVALID', 'State a non-zero amount, in major units.');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'rlp_reserve:' + input.countryCode}))`;
  const balance = await reserveBalance(tx, input.countryCode);
  if (balance + input.amount < 0) {
    throw new AppError(409, 'RLP_RESERVE_UNFUNDED', `That correction would take the ${input.countryCode} reserve below zero (balance ${balance.toLocaleString()}).`);
  }
  const row = await tx.rlpReserveEntry.create({ data: { countryCode: input.countryCode, kind: 'ADJUSTMENT', amount: input.amount, createdById: input.byId, note: input.note } });
  return { id: row.id, balanceAfter: balance + input.amount };
}

export interface ReserveStatement {
  countryCode: string;
  balance: number;
  floor: number;
  low: boolean;
  provisionedThisPeriod: boolean;
  entries: Array<{ id: string; kind: string; amount: string; periodKey: string | null; claimId: string | null; note: string | null; createdAt: string }>;
}

export async function reserveStatement(
  db: Db,
  countryCode: string,
  ctx: { gateLocal: number; rules: LossProtectionRules; now?: Date; take?: number },
): Promise<ReserveStatement> {
  const now = ctx.now ?? new Date();
  const balance = await reserveBalance(db, countryCode);
  const floor = ctx.gateLocal * ctx.rules.rlpReserveFloorMultiple;
  const period = periodKeyOf(now);
  const provisioned = await db.rlpReserveEntry.findFirst({ where: { countryCode, kind: 'PROVISION', periodKey: period }, select: { id: true } });
  const rows = await db.rlpReserveEntry.findMany({ where: { countryCode }, orderBy: { createdAt: 'desc' }, take: ctx.take ?? 50 });
  return {
    countryCode, balance, floor, low: balance < floor, provisionedThisPeriod: Boolean(provisioned),
    entries: rows.map((r) => ({ id: r.id, kind: r.kind, amount: String(r.amount), periodKey: r.periodKey, claimId: r.claimId, note: r.note, createdAt: r.createdAt.toISOString() })),
  };
}

/** The calendar month a provisioning row belongs to (UTC), e.g. "2026-09". */
export function periodKeyOf(d: Date): string { return d.toISOString().slice(0, 7); }

/**
 * Monthly provisioning: PREVIOUS month's PAID subscription revenue, by the payer's
 * country, times the provisioning rate — one PROVISION row per country per month,
 * idempotent by the (country, kind, periodKey) unique. A month with no revenue
 * provisions nothing and says so. Re-running is safe; it adds nothing twice.
 */
export async function provisionReserveForPreviousMonth(
  prisma: PrismaClient,
  opts: { now?: Date; rulesFor: (countryCode: string) => Promise<LossProtectionRules>; notifications?: NotificationService },
): Promise<Array<{ countryCode: string; periodKey: string; revenue: number; provisioned: number; created: boolean }>> {
  const now = opts.now ?? new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodKey = periodKeyOf(monthStart);
  const payments = await prisma.subscriptionPayment.findMany({
    where: { status: 'CAPTURED', paidAt: { gte: monthStart, lt: monthEnd } },
    select: {
      amount: true,
      subscription: { select: {
        rider: { select: { user: { select: { countryCode: true } } } },
        driver: { select: { user: { select: { countryCode: true } } } },
        vendor: { select: { owner: { select: { user: { select: { countryCode: true } } } } } },
      } },
    },
  });
  const revenue = new Map<string, number>();
  for (const p of payments) {
    const s = p.subscription;
    const country = s.rider?.user.countryCode ?? s.driver?.user.countryCode ?? s.vendor?.owner.user.countryCode ?? null;
    if (!country) continue;
    revenue.set(country, (revenue.get(country) ?? 0) + Number(p.amount));
  }
  const out: Array<{ countryCode: string; periodKey: string; revenue: number; provisioned: number; created: boolean }> = [];
  for (const [countryCode, total] of revenue) {
    const rules = await opts.rulesFor(countryCode);
    const provisioned = Math.round(total * rules.rlpReserveRatePct) / 100;
    let created = false;
    if (provisioned > 0) {
      try {
        await prisma.rlpReserveEntry.create({ data: {
          countryCode, kind: 'PROVISION', amount: provisioned, periodKey, note: `${rules.rlpReserveRatePct}% of ${periodKey} paid fee revenue (${total.toLocaleString()})`,
        } });
        created = true;
      } catch (err) {
        if (!(typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002')) throw err;
      }
    }
    out.push({ countryCode, periodKey, revenue: total, provisioned, created });
    if (created && opts.notifications) {
      const balance = await reserveBalance(prisma, countryCode);
      await notifyAdmins(prisma, opts.notifications, {
        tenantId: null,
        title: `Loss-protection reserve provisioned (${countryCode})`,
        body: `${provisioned.toLocaleString()} added for ${periodKey} (${rules.rlpReserveRatePct}% of ${total.toLocaleString()} paid fee revenue). The reserve line now holds ${balance.toLocaleString()}.`,
        data: { kind: 'rlp_reserve_provisioned', countryCode, periodKey, provisioned, balance },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The daily sweep — SLA breaches and a low reserve, said once a day
// ---------------------------------------------------------------------------

export interface LossProtectionSweep {
  runAt: string;
  slaHours: Record<string, number>;
  breached: Array<{ claimId: string; ageHours: number; countryCode: string; status: string; amount: string }>;
  newlyFlagged: number;
  lowReserve: Array<{ countryCode: string; balance: number; floor: number }>;
}

/**
 * Every approved claim older than the SLA and unpaid is flagged ONCE (`sla_breached`)
 * and listed; every country whose reserve stands below the floor is listed. One audit
 * row per run, at most one admin notice per day per finding kind.
 */
export async function sweepLossProtection(
  prisma: PrismaClient,
  opts: {
    now?: Date;
    notifications?: NotificationService;
    rulesFor: (countryCode: string) => Promise<LossProtectionRules>;
    gateFor: (countryCode: string) => Promise<number>;
  },
): Promise<LossProtectionSweep> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const openRows = await prisma.reimbursementClaim.findMany({
    where: { status: { in: ['AUTO_APPROVED', 'APPROVED'] } },
    select: { id: true, amount: true, status: true, flags: true, createdAt: true, orderId: true },
  });
  // A claim carries no country of its own; the order's customer does.
  const orders = await prisma.order.findMany({
    where: { id: { in: openRows.map((c) => c.orderId) } },
    select: { id: true, customer: { select: { countryCode: true } } },
  });
  const countryOf = new Map(orders.map((o) => [o.id, o.customer.countryCode]));
  const open = openRows.map((c) => ({ ...c, countryCode: countryOf.get(c.orderId) ?? 'GY' }));
  const slaHours: Record<string, number> = {};
  const breached: LossProtectionSweep['breached'] = [];
  let newlyFlagged = 0;
  for (const c of open) {
    const countryCode = c.countryCode;
    if (slaHours[countryCode] == null) slaHours[countryCode] = (await opts.rulesFor(countryCode)).rlpSlaHours;
    const ageHours = (now.getTime() - c.createdAt.getTime()) / 3_600_000;
    if (ageHours < slaHours[countryCode]!) continue;
    breached.push({ claimId: c.id, ageHours: Math.floor(ageHours), countryCode, status: c.status, amount: String(c.amount) });
    if (!c.flags.includes(LOSS_PROTECTION_FLAGS.slaBreached)) {
      // Flag once; a flag is a fact on the row, so the admin queue sorts on it.
      const res = await prisma.reimbursementClaim.updateMany({
        where: { id: c.id, NOT: { flags: { has: LOSS_PROTECTION_FLAGS.slaBreached } } },
        data: { flags: { push: LOSS_PROTECTION_FLAGS.slaBreached } },
      });
      newlyFlagged += res.count;
    }
  }
  const countries = new Set<string>([...open.map((c) => c.countryCode), ...(await prisma.rlpReserveEntry.findMany({ distinct: ['countryCode'], select: { countryCode: true } })).map((r) => r.countryCode)]);
  const lowReserve: LossProtectionSweep['lowReserve'] = [];
  for (const countryCode of countries) {
    const [balance, gate, rules] = await Promise.all([reserveBalance(prisma, countryCode), opts.gateFor(countryCode), opts.rulesFor(countryCode)]);
    const floor = gate * rules.rlpReserveFloorMultiple;
    if (balance < floor) lowReserve.push({ countryCode, balance, floor });
  }
  await prisma.auditLog.create({ data: {
    action: 'RLP_SWEEP', entity: 'ReimbursementClaim', entityId: `daily:${today}`,
    changes: { checked: open.length, breached: breached.length, newlyFlagged, lowReserve: lowReserve.map((l) => l.countryCode) },
  } });
  if (opts.notifications) {
    if (breached.length > 0 && !(await noticedToday(prisma, 'rlp_sla_breached', today))) {
      await notifyAdmins(prisma, opts.notifications, {
        tenantId: null,
        title: `${breached.length} loss-protection payout${breached.length === 1 ? '' : 's'} past the SLA`,
        body: `Approved claims unpaid beyond the pay-out SLA: ${breached.map((b) => `${b.amount} (${b.ageHours} h)`).slice(0, 5).join(', ')}${breached.length > 5 ? ', …' : ''}. A rider who is owed money and waiting stops taking cash orders — pay from the reserve line today.`,
        data: { kind: 'rlp_sla_breached', breached: breached.length, date: today },
      });
    }
    if (lowReserve.length > 0 && !(await noticedToday(prisma, 'rlp_reserve_low', today))) {
      await notifyAdmins(prisma, opts.notifications, {
        tenantId: null,
        title: 'Loss-protection reserve below its floor',
        body: lowReserve.map((l) => `${l.countryCode}: ${l.balance.toLocaleString()} of a ${l.floor.toLocaleString()} floor`).join('; ') + '. Payouts refuse once the line is empty — provision it.',
        data: { kind: 'rlp_reserve_low', countries: lowReserve.map((l) => l.countryCode), date: today },
      });
    }
  }
  return { runAt: now.toISOString(), slaHours, breached, newlyFlagged, lowReserve };
}

async function noticedToday(prisma: PrismaClient, kind: string, today: string): Promise<boolean> {
  const already = await prisma.notification.findFirst({
    where: { data: { path: ['kind'], equals: kind }, createdAt: { gte: new Date(`${today}T00:00:00Z`) } },
    select: { id: true },
  });
  return Boolean(already);
}

// ---------------------------------------------------------------------------
// The database backstop, mirrored verbatim in the migration (asserted by the suite).
// ---------------------------------------------------------------------------

export function rlpReserveDdl(): string {
  return `CREATE OR REPLACE FUNCTION rlp_reserve_nonnegative() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal NUMERIC;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('rlp_reserve:' || NEW."countryCode"));
  SELECT COALESCE(SUM(amount), 0) INTO bal FROM rlp_reserve_entries WHERE "countryCode" = NEW."countryCode";
  IF bal < 0 THEN
    RAISE EXCEPTION 'RLP_RESERVE_UNFUNDED: the % loss-protection reserve would stand at % after this entry', NEW."countryCode", bal USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rlp_reserve_entries_nonnegative ON rlp_reserve_entries;
CREATE TRIGGER rlp_reserve_entries_nonnegative AFTER INSERT OR UPDATE OF amount, "countryCode" ON rlp_reserve_entries FOR EACH ROW EXECUTE FUNCTION rlp_reserve_nonnegative();`;
}

// ---------------------------------------------------------------------------
// The mover's own view of their claims — what the rider app shows.
// ---------------------------------------------------------------------------
export interface MoverClaimView {
  id: string; orderId: string; amount: string; status: string; reason: string; flags: string[];
  filedAt: string; paidAt: string | null; paymentRef: string | null;
  /** The bundle as it stood at filing: what a reviewer needs and what is missing. */
  evidence: { complete: boolean; missing: string[]; items: Array<{ key: string; present: boolean; required: boolean }> } | null;
  /** For an approved, unpaid claim: when the pay-out SLA runs out. */
  payoutDueBy: string | null;
  underReview: boolean;
}

export async function moverClaims(
  db: Db,
  mover: { riderId: string | null; driverId: string | null },
  rules: LossProtectionRules,
  opts: { take?: number } = {},
): Promise<{ claims: MoverClaimView[]; suspended: boolean; suspendedAt: string | null }> {
  const mine = mover.riderId ? { riderId: mover.riderId } : { driverId: mover.driverId };
  const [rows, account] = await Promise.all([
    db.reimbursementClaim.findMany({ where: mine, orderBy: { createdAt: 'desc' }, take: opts.take ?? 50 }),
    (async () => {
      const userId = await moverUserIdOf(db, mover);
      return userId ? db.user.findUnique({ where: { id: userId }, select: { lossProtectionSuspendedAt: true } }) : null;
    })(),
  ]);
  const claims = rows.map((c) => {
    const ev = c.evidence as { complete?: boolean; missing?: string[]; items?: Array<{ key: string; present: boolean; required: boolean }> } | null;
    const approvedUnpaid = c.status === 'AUTO_APPROVED' || c.status === 'APPROVED';
    return {
      id: c.id, orderId: c.orderId, amount: String(c.amount), status: c.status, reason: c.reason, flags: c.flags,
      filedAt: c.createdAt.toISOString(), paidAt: c.paidAt ? c.paidAt.toISOString() : null, paymentRef: c.paymentRef ?? null,
      evidence: ev ? { complete: Boolean(ev.complete), missing: ev.missing ?? [], items: (ev.items ?? []).map((i) => ({ key: i.key, present: i.present, required: i.required })) } : null,
      payoutDueBy: approvedUnpaid ? new Date(c.createdAt.getTime() + rules.rlpSlaHours * 3_600_000).toISOString() : null,
      underReview: c.status === 'PENDING_REVIEW',
    };
  });
  return { claims, suspended: Boolean(account?.lossProtectionSuspendedAt), suspendedAt: account?.lossProtectionSuspendedAt?.toISOString() ?? null };
}

