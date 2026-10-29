import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [BILL-PRO PR0] Who owns (and pays for) a weekly-fee subscription: ONE module.
 *
 * A Subscription has no owner of its own. It is held by exactly one of a rider,
 * a driver or a store (a vendor, paid by the store's owner). Every billing,
 * notice, checkout, erasure and tenant path used to repeat that rule inline,
 * as `rider?.userId ?? driver?.userId ?? vendor?.owner.userId` in TypeScript
 * or as a three-way LEFT JOIN of riders / drivers / vendors in SQL. A new kind
 * of owner then has to be added in one place, here.
 *
 * Every helper keeps the exact rule of the copies it replaced (refactor only):
 * the payer is the rider's user, else the driver's, else the store owner's,
 * in that order. The source-scan gate (subscription-owner-single-source.test.ts)
 * fails the build on a new inline copy outside this file.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The owner relations as a caller loaded them (an include or select of
 *  `rider { userId }`, `driver { userId }`, `vendor { owner { userId } }`). */
export interface PayerRelations {
  rider?: { userId: string } | null;
  driver?: { userId: string } | null;
  vendor?: { owner: { userId: string } } | null;
}

/** The user who pays this subscription's fee, or null when no owner is loaded. */
export function payerUserIdOf(sub: PayerRelations | null | undefined): string | null {
  return sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId ?? null;
}

/** The mover (rider or driver) who pays, or null for a store's subscription. */
export function moverUserIdOf(sub: Pick<PayerRelations, 'rider' | 'driver'> | null | undefined): string | null {
  return sub?.rider?.userId ?? sub?.driver?.userId ?? null;
}

export type SubscriptionOwnerKind = 'RIDER' | 'DRIVER' | 'VENDOR';

/** The payer and the role they pay in, in the payer order above. */
export function payerOf(sub: PayerRelations | null | undefined): { userId: string; kind: SubscriptionOwnerKind } | null {
  const userId = payerUserIdOf(sub);
  if (!userId) return null;
  return { userId, kind: sub?.rider ? 'RIDER' : sub?.driver ? 'DRIVER' : 'VENDOR' };
}

/** The app surface a fee notice belongs to: the business app for a store's
 *  fee, the earner app for a mover's. */
export function payerAudienceOf(sub: { vendor?: unknown } | null | undefined): 'business' | 'earner' {
  return sub?.vendor ? 'business' : 'earner';
}

/** Every subscription this person pays: as a rider, a driver, or a store's owner. */
export function subscriptionsPaidBy(userId: string | { in: string[] }): Prisma.SubscriptionWhereInput {
  return { OR: [{ rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }] };
}

/** [M-15] A subscription belongs to the tenant of the vendor, rider or driver
 *  that holds it, and only a row with exactly one owner belongs anywhere. */
export const subscriptionTenantWhere = (tenantId: string) => ({
  OR: [
    { vendor: { tenantId }, riderId: null, driverId: null },
    { rider: { user: { tenantId } }, vendorId: null, driverId: null },
    { driver: { user: { tenantId } }, vendorId: null, riderId: null },
  ],
});

export interface SubscriptionOwner {
  kind: SubscriptionOwnerKind;
  /** The user who pays. */
  userId: string;
  /** The paying user's tenant. */
  tenantId: string;
  /** The store, for a store's subscription. */
  vendorId?: string;
  /** How many owner columns the row sets; a well-formed row sets exactly one. */
  ownerColumns: number;
}

/** The owner columns and owner users of a subscription, as one select. */
export const SUBSCRIPTION_OWNER_SELECT = {
  riderId: true, driverId: true, vendorId: true,
  rider: { select: { user: { select: { id: true, tenantId: true } } } },
  driver: { select: { user: { select: { id: true, tenantId: true } } } },
  vendor: { select: { tenantId: true, owner: { select: { user: { select: { id: true, tenantId: true } } } } } },
} as const satisfies Prisma.SubscriptionSelect;

type OwnerRow = Prisma.SubscriptionGetPayload<{ select: typeof SUBSCRIPTION_OWNER_SELECT }>;

/** The owner of a row read with SUBSCRIPTION_OWNER_SELECT, or null when no
 *  owner user is found. */
export function ownerOfRow(sub: OwnerRow): SubscriptionOwner | null {
  const user = sub.rider?.user ?? sub.driver?.user ?? sub.vendor?.owner.user;
  if (!user) return null;
  const kind: SubscriptionOwnerKind = sub.rider?.user ? 'RIDER' : sub.driver?.user ? 'DRIVER' : 'VENDOR';
  return {
    kind,
    userId: user.id,
    tenantId: user.tenantId,
    ...(sub.vendorId ? { vendorId: sub.vendorId } : {}),
    ownerColumns: [sub.riderId, sub.driverId, sub.vendorId].filter(Boolean).length,
  };
}

/** Read a subscription's owner. Null when the row is missing or no owner user
 *  is found. Callers that require a well-formed row check `ownerColumns`. */
export async function subscriptionOwnerOf(db: Db, subscriptionId: string): Promise<SubscriptionOwner | null> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId }, select: SUBSCRIPTION_OWNER_SELECT });
  return sub ? ownerOfRow(sub) : null;
}

/** The mover's own user record (rider, else driver) as the caller selected it;
 *  null for a store's subscription. Display names and contact numbers. */
export function moverUserOf<T>(sub: { rider?: { user: T } | null; driver?: { user: T } | null } | null | undefined): T | null {
  return sub?.rider?.user ?? sub?.driver?.user ?? null;
}

/** [AX363-F2] The tenant that owns a subscription, by the one ownership rule
 *  the admin tenant scope uses: exactly one owner, a vendor (its tenant) or a
 *  rider or driver (their user's tenant). Read explicitly, whatever query
 *  extension the caller's client carries. Null: missing, or ownership
 *  ambiguous; a caller comparing it to a tenant then fails closed. */
export async function subscriptionOwnerTenant(db: Db, subscriptionId: string): Promise<string | null> {
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      vendorId: true, riderId: true, driverId: true,
      vendor: { select: { tenantId: true } },
      rider: { select: { user: { select: { tenantId: true } } } },
      driver: { select: { user: { select: { tenantId: true } } } },
    },
  });
  if (!sub) return null;
  if ([sub.vendorId, sub.riderId, sub.driverId].filter((owner) => owner !== null).length !== 1) return null;
  return ownerTenantOf(sub);
}

/** The owner's tenant on a row already read: a store's own tenant, else the
 *  rider's or the driver's user's. No exactly-one-owner check (callers that
 *  need one use subscriptionOwnerTenant). */
export function ownerTenantOf(sub: {
  vendor?: { tenantId: string } | null;
  rider?: { user: { tenantId: string } } | null;
  driver?: { user: { tenantId: string } } | null;
}): string | null {
  return sub.vendor?.tenantId ?? sub.rider?.user.tenantId ?? sub.driver?.user.tenantId ?? null;
}

// ── SQL ─────────────────────────────────────────────────────────────────────
// For raw statements over `subscriptions s`. The aliases are fixed: r (riders),
// d (drivers), v (vendors), vo (vendor_owners), u (the paying user).

/** The owner rows of `subscriptions s`, all optional (LEFT JOIN). */
export const SUBSCRIPTION_OWNER_JOINS_SQL = Prisma.sql`
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    LEFT JOIN "vendors" v ON v."id" = s."vendorId"
    LEFT JOIN "vendor_owners" vo ON vo."id" = v."ownerId"`;

/** The paying user's id, in the payer order (after SUBSCRIPTION_OWNER_JOINS_SQL). */
export const SUBSCRIPTION_PAYER_USER_ID_SQL = Prisma.sql`COALESCE(r."userId", d."userId", vo."userId")`;

/** [F7] The owner rows plus the paying user as `u`, whose "tenantId" is the
 *  tenant the subscription's money belongs to (an inner join: a row with no
 *  payer drops out). subscriptionTenantInTx below is this same statement. */
export const subscriptionTenantSql = Prisma.sql`${SUBSCRIPTION_OWNER_JOINS_SQL}
    JOIN "users" u ON u."id" = ${SUBSCRIPTION_PAYER_USER_ID_SQL}`;

/** A condition on the owner rows: this person pays the subscription (any owner role). */
export function subscriptionPaidBySql(userId: string): Prisma.Sql {
  return Prisma.sql`(r."userId" = ${userId} OR d."userId" = ${userId} OR vo."userId" = ${userId})`;
}

/**
 * [F7] The tenant a subscription's money belongs to: its payer's. A
 * Subscription carries no tenantId of its own. Read without the request's
 * tenant scope so a platform operator's command still finds it; throws rather
 * than guessing, because a guessed tenant would file the payment evidence
 * under someone else's books.
 *
 * The statement is written out in full (it is subscriptionTenantSql) because
 * transaction doubles in the billing suites recognise it by its text; the
 * owner unit test pins the two texts equal.
 */
export async function subscriptionTenantInTx(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, subscriptionId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ tenantId: string }>>`
    SELECT u."tenantId" AS "tenantId"
    FROM "subscriptions" s
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    LEFT JOIN "vendors" v ON v."id" = s."vendorId"
    LEFT JOIN "vendor_owners" vo ON vo."id" = v."ownerId"
    JOIN "users" u ON u."id" = COALESCE(r."userId", d."userId", vo."userId")
    WHERE s."id" = ${subscriptionId}
  `;
  const tenantId = rows[0]?.tenantId;
  if (!tenantId) throw new AppError(500, 'SUBSCRIPTION_TENANT_UNKNOWN', `Subscription ${subscriptionId} has no payer to take a tenant from.`);
  return tenantId;
}
