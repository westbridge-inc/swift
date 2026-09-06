/**
 * [DOC-1 §3.6 · FD-DOC-1 · P3-2] The micro-vendor tier — a capped tier, not a bypass.
 *
 * Most Guyanese snackettes, home cooks and stall vendors are not registered with DCRA.
 * Blocking them leaves Swift with no supply; onboarding them blind leaves Swift the
 * liability. The ruling is a tier: a verified PERSON under a signed, versioned,
 * hashed self-declaration, with a storefront photo and — never waived — the food
 * handler permit when prepared food is sold, trades under caps until a business
 * registration record is VALID, at which point promotion is automatic and every cap
 * lifts. This file is the ONE author of the caps, the usage window, the checkout
 * refusal, the promotion predicate and the "no promoted placement" rule.
 *
 * What the caps mean under the no-custody money model (§31): Swift never holds a
 * vendor's money, so `payout_hold_days` has nothing to hold and is NOT APPLICABLE
 * (CONFLICT recorded in the register); `max_payout_per_week` is read as the gross
 * order value the tier may transact per rolling week — the same exposure the cap was
 * written to bound.
 */
import type { Prisma, PrismaClient, Vendor, VendorTier } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { CountryConfigService } from '../country/country-config.service';
import { REGISTRATION_DOC_TYPES } from '../verification/doc-registry';
export { REGISTRATION_DOC_TYPES };

type Db = PrismaClient | Prisma.TransactionClient;

export interface VendorTierCaps {
  /** Orders a day (calendar day, the vendor's tenant clock is UTC today). */
  ordersPerDay: number;
  /** Gross order value per rolling 7 days, major units (subtotalBase of non-cancelled orders). */
  grossPerWeek: number;
  /** The nudge fires at this fraction of either cap. */
  nudgeAtFraction: number;
}

/** FD-DOC-1 agent defaults (founder-inputs.md): conservative, tunable per CountryConfig. */
export const VENDOR_TIER_CAPS_DEFAULTS: VendorTierCaps = {
  ordersPerDay: 30,
  grossPerWeek: 150_000,
  nudgeAtFraction: 0.6,
};


export async function vendorTierCapsFor(countryConfig: CountryConfigService, countryCode: string): Promise<VendorTierCaps> {
  const config = await countryConfig.getByCode(countryCode);
  const stored = (config as { vendorTierCaps?: unknown }).vendorTierCaps as Partial<VendorTierCaps> | null | undefined;
  return { ...VENDOR_TIER_CAPS_DEFAULTS, ...(stored ?? {}) };
}

export interface TierUsage { ordersToday: number; grossThisWeek: number; dayStart: Date; weekStart: Date }

/** What an UNREGISTERED vendor has transacted in the two windows — cancelled orders do not count. */
export async function tierUsage(db: Db, vendorId: string, now: Date): Promise<TierUsage> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const [ordersToday, gross] = await Promise.all([
    db.order.count({ where: { vendorId, placedAt: { gte: dayStart, lte: now }, status: { not: 'CANCELLED' } } }),
    db.order.aggregate({ _sum: { subtotalBase: true }, where: { vendorId, placedAt: { gte: weekStart, lte: now }, status: { not: 'CANCELLED' } } }),
  ]);
  return { ordersToday, grossThisWeek: Number(gross._sum.subtotalBase ?? 0), dayStart, weekStart };
}

export type TierCapVerdict =
  | { allowed: true; usage: TierUsage; nudge: boolean }
  | { allowed: false; usage: TierUsage; nudge: boolean; cap: 'ORDERS_PER_DAY' | 'GROSS_PER_WEEK' };

/** The pure decision: would THIS order (its food cost) take the tier past a cap? */
export function judgeTierCap(usage: TierUsage, caps: VendorTierCaps, orderGross: number): TierCapVerdict {
  const nudge = usage.ordersToday + 1 >= caps.ordersPerDay * caps.nudgeAtFraction || usage.grossThisWeek + orderGross >= caps.grossPerWeek * caps.nudgeAtFraction;
  if (usage.ordersToday + 1 > caps.ordersPerDay) return { allowed: false, usage, nudge, cap: 'ORDERS_PER_DAY' };
  if (usage.grossThisWeek + orderGross > caps.grossPerWeek) return { allowed: false, usage, nudge, cap: 'GROSS_PER_WEEK' };
  return { allowed: true, usage, nudge };
}

/**
 * The checkout gate. A REGISTERED vendor is never judged. An UNREGISTERED vendor past a
 * cap refuses the order with the cap named — a business rule in the customer's face,
 * so the copy says what the store has to do, not what the customer did wrong.
 */
export async function assertWithinTierCaps(
  db: Db,
  vendor: Pick<Vendor, 'id' | 'name' | 'tier'>,
  caps: VendorTierCaps,
  orderGross: number,
  now: Date,
): Promise<TierCapVerdict | null> {
  if (vendor.tier !== 'UNREGISTERED') return null;
  const verdict = judgeTierCap(await tierUsage(db, vendor.id, now), caps, orderGross);
  if (!verdict.allowed) {
    throw new AppError(
      409,
      'VENDOR_TIER_CAP',
      verdict.cap === 'ORDERS_PER_DAY'
        ? `${vendor.name} has reached today's order limit for an unregistered seller (${caps.ordersPerDay} a day). Try again tomorrow.`
        : `${vendor.name} has reached this week's sales limit for an unregistered seller. Try again later this week.`,
      { cap: verdict.cap, ordersToday: verdict.usage.ordersToday, grossThisWeek: verdict.usage.grossThisWeek },
    );
  }
  return verdict;
}

/** No promoted placement at the unregistered tier (§3.6 marketplace_visibility = LIMITED). */
export function assertPromotable(vendor: Pick<Vendor, 'name' | 'tier'>): void {
  if (vendor.tier === 'UNREGISTERED') {
    throw new AppError(409, 'VENDOR_TIER_NO_PROMOTION', `${vendor.name} is an unregistered seller; promoted placement opens once a business registration is on file.`);
  }
}

/** THE definition of "registered": a VALID, unexpired registration record for the owner. One reader for promotion and for the declaration route. */
export async function validRegistrationRecord(db: Db, ownerUserId: string, now = new Date()): Promise<{ id: string; docType: string } | null> {
  return db.documentRecord.findFirst({
    where: { accountId: ownerUserId, docType: { in: [...REGISTRATION_DOC_TYPES] }, status: 'VALID', OR: [{ expiresOn: null }, { expiresOn: { gt: now } }] },
    select: { id: true, docType: true },
  });
}

/**
 * Promotion: a VALID registration record for the owner promotes every UNREGISTERED
 * store to REGISTERED, once, with an audit row. Idempotent; a REGISTERED store is untouched.
 * Demotion is never automatic — a lapsed registration is a review case, not a cap.
 */
export async function promoteIfRegistered(
  db: Db,
  ownerUserId: string,
  now = new Date(),
  /** Tells the owner — the promotion is theirs to see, not a silent flag flip. */
  onPromoted?: (vendorId: string, ownerUserId: string) => Promise<void>,
): Promise<string[]> {
  const record = await validRegistrationRecord(db, ownerUserId, now);
  if (!record) return [];
  const owner = await db.vendorOwner.findUnique({ where: { userId: ownerUserId }, select: { vendors: { where: { tier: 'UNREGISTERED' }, select: { id: true } } } });
  if (!owner || owner.vendors.length === 0) return [];
  const promoted: string[] = [];
  for (const v of owner.vendors) {
    const res = await db.vendor.updateMany({ where: { id: v.id, tier: 'UNREGISTERED' }, data: { tier: 'REGISTERED', tierChangedAt: now, tierNote: `promoted: VALID ${record.docType} record ${record.id}` } });
    if (res.count !== 1) continue;
    await db.auditLog.create({ data: { action: 'VENDOR_TIER_PROMOTED', entity: 'Vendor', entityId: v.id, changes: { from: 'UNREGISTERED', to: 'REGISTERED', recordId: record.id, docType: record.docType } } });
    promoted.push(v.id);
    await onPromoted?.(v.id, ownerUserId).catch(() => {});
  }
  return promoted;
}

export function isCappedTier(tier: VendorTier): boolean { return tier === 'UNREGISTERED'; }

/**
 * The 60% nudge (§3.6): once a day, when a checkout finds the store at or past the nudge
 * fraction of either cap, the owner is told where they stand and how to register. Never
 * more than one a day per store; never on a refused order (that carries its own message).
 */
export async function nudgeOwnerOnce(
  db: Db,
  notifications: { send: (input: { userId: string; type: 'SYSTEM_ANNOUNCEMENT'; title: string; body: string; data: Record<string, unknown> }) => Promise<unknown> },
  vendor: Pick<Vendor, 'id' | 'name' | 'ownerId'>,
  verdict: TierCapVerdict,
  caps: VendorTierCaps,
  now: Date,
): Promise<boolean> {
  if (!verdict.nudge) return false;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const already = await db.notification.findFirst({
    where: { data: { path: ['kind'], equals: 'vendor_tier_nudge' }, AND: [{ data: { path: ['vendorId'], equals: vendor.id } }], createdAt: { gte: dayStart } },
    select: { id: true },
  });
  if (already) return false;
  const owner = await db.vendorOwner.findUnique({ where: { id: vendor.ownerId }, select: { userId: true } });
  if (!owner) return false;
  await notifications.send({
    userId: owner.userId,
    type: 'SYSTEM_ANNOUNCEMENT',
    title: `${vendor.name}: you are near your unregistered-seller limit`,
    body: `Today ${verdict.usage.ordersToday} of ${caps.ordersPerDay} orders; this week ${verdict.usage.grossThisWeek.toLocaleString()} of ${caps.grossPerWeek.toLocaleString()} in sales. Registering your business with the DCRA lifts every limit the day the certificate is on file: register the business name (Business Names (Registration) Act), get the certificate, then upload it under Documents.`,
    data: { kind: 'vendor_tier_nudge', vendorId: vendor.id, ordersToday: verdict.usage.ordersToday, grossThisWeek: verdict.usage.grossThisWeek },
  });
  return true;
}

