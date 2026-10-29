import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [BILL-PRO PR0] Who owns (and pays for) a weekly-fee subscription: ONE module.
 *
 * A Subscription has no owner of its own. It is held by exactly one of a rider,
 * a driver, a store (a vendor, paid by the store's owner) or, since BILL-PRO
 * PR1, an independent service provider (a pro). Every billing,
 * notice, checkout, erasure and tenant path used to repeat that rule inline,
 * as `rider?.userId ?? driver?.userId ?? vendor?.owner.userId` in TypeScript
 * or as a three-way LEFT JOIN of riders / drivers / vendors in SQL. A new kind
 * of owner then has to be added in one place, here.
 *
 * The payer is the rider's user, else the driver's, else the store owner's,
 * else the pro's, in that order. The database lets a new row have exactly one
 * owner, so the order only matters for legacy rows. The source-scan gate
 * (subscription-owner-single-source.test.ts) fails the build on a new inline
 * copy outside this file.
 *
 * [BILL-PRO PR2] A loaded row must say whether a pro owns it. Reads use
 * PAYER_INCLUDE (the source gate refuses a hand-written owner include), and a
 * row whose `serviceProviderId` is set but whose pro was not loaded throws
 * (PAYER_NOT_LOADED) instead of answering "nobody pays".
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The owner relations as a caller loaded them (PAYER_INCLUDE: `rider { userId }`,
 *  `driver { userId }`, `vendor { owner { userId } }`, `serviceProvider { userId }`). */
export interface PayerRelations {
  rider?: { userId: string } | null;
  driver?: { userId: string } | null;
  vendor?: { owner: { userId: string } } | null;
  serviceProvider?: { userId: string } | null;
  serviceProviderId?: string | null;
}

/** Every owner relation a payer read needs, as one Prisma include. Use it
 *  (or spread it) instead of writing the owner relations out. */
export const PAYER_INCLUDE = {
  rider: { select: { userId: true } },
  driver: { select: { userId: true } },
  vendor: { select: { id: true, owner: { select: { userId: true } } } },
  serviceProvider: { select: { userId: true } },
} as const satisfies Prisma.SubscriptionInclude;

/** A row that names a pro but was read without the pro relation (a cast hid
 *  the missing include): refuse, never answer "nobody pays". */
function assertProLoaded(sub: { serviceProvider?: unknown; serviceProviderId?: string | null } | null | undefined): void {
  if (sub?.serviceProviderId && sub.serviceProvider === undefined) {
    throw new AppError(500, 'PAYER_NOT_LOADED', 'A pro subscription was read without its owner.');
  }
}

/** The user who pays this subscription's fee, or null when no owner is loaded. */
export function payerUserIdOf(sub: PayerRelations | null | undefined): string | null {
  assertProLoaded(sub);
  return sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId ?? sub?.serviceProvider?.userId ?? null;
}

/** The mover (rider or driver) who pays, or null for a store's or a pro's subscription. */
export function moverUserIdOf(sub: Pick<PayerRelations, 'rider' | 'driver'> | null | undefined): string | null {
  return sub?.rider?.userId ?? sub?.driver?.userId ?? null;
}

export type SubscriptionOwnerKind = 'RIDER' | 'DRIVER' | 'VENDOR' | 'PROVIDER';

/** The payer and the role they pay in, in the payer order above. */
export function payerOf(sub: PayerRelations | null | undefined): { userId: string; kind: SubscriptionOwnerKind } | null {
  const userId = payerUserIdOf(sub);
  if (!userId) return null;
  return { userId, kind: sub?.rider ? 'RIDER' : sub?.driver ? 'DRIVER' : sub?.vendor ? 'VENDOR' : 'PROVIDER' };
}

/** The app surface a fee notice belongs to: the business app for a store's
 *  fee, the earner app for a mover's, the provider surface for a pro's. A
 *  surface no shipped build knows keeps a pro's fee out of the customer inbox
 *  and the mover fee screen (BILL-PRO PR4 routes it). */
export function payerAudienceOf(sub: { vendor?: unknown; vendorId?: string | null; serviceProvider?: unknown; serviceProviderId?: string | null } | null | undefined): 'business' | 'earner' | 'provider' {
  if (sub?.vendor || sub?.vendorId) return 'business';
  if (sub?.serviceProvider || sub?.serviceProviderId) return 'provider';
  return 'earner';
}

/** Every subscription this person pays: as a rider, a driver, a store's owner or a pro. */
export function subscriptionsPaidBy(userId: string | { in: string[] }): Prisma.SubscriptionWhereInput {
  return { OR: [{ rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }, { serviceProvider: { userId } }] };
}

/** [M-15] A subscription belongs to the tenant of the vendor, rider, driver or
 *  pro that holds it, and only a row with exactly one owner belongs anywhere. */
export const subscriptionTenantWhere = (tenantId: string) => ({
  OR: [
    { vendor: { tenantId }, riderId: null, driverId: null, serviceProviderId: null },
    { rider: { user: { tenantId } }, vendorId: null, driverId: null, serviceProviderId: null },
    { driver: { user: { tenantId } }, vendorId: null, riderId: null, serviceProviderId: null },
    { serviceProvider: { user: { tenantId } }, vendorId: null, riderId: null, driverId: null },
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
  /** The pro profile, for a pro's subscription. */
  serviceProviderId?: string;
  /** How many owner columns the row sets; a well-formed row sets exactly one. */
  ownerColumns: number;
}

/** The owner columns and owner users of a subscription, as one select. */
export const SUBSCRIPTION_OWNER_SELECT = {
  riderId: true, driverId: true, vendorId: true, serviceProviderId: true,
  rider: { select: { user: { select: { id: true, tenantId: true } } } },
  driver: { select: { user: { select: { id: true, tenantId: true } } } },
  vendor: { select: { tenantId: true, owner: { select: { user: { select: { id: true, tenantId: true } } } } } },
  serviceProvider: { select: { user: { select: { id: true, tenantId: true } } } },
} as const satisfies Prisma.SubscriptionSelect;

type OwnerRow = Prisma.SubscriptionGetPayload<{ select: typeof SUBSCRIPTION_OWNER_SELECT }>;

/** The owner of a row read with SUBSCRIPTION_OWNER_SELECT, or null when no
 *  owner user is found. */
export function ownerOfRow(sub: OwnerRow): SubscriptionOwner | null {
  const user = sub.rider?.user ?? sub.driver?.user ?? sub.vendor?.owner.user ?? sub.serviceProvider?.user;
  if (!user) return null;
  const kind: SubscriptionOwnerKind = sub.rider?.user ? 'RIDER' : sub.driver?.user ? 'DRIVER' : sub.vendor?.owner.user ? 'VENDOR' : 'PROVIDER';
  return {
    kind,
    userId: user.id,
    tenantId: user.tenantId,
    ...(sub.vendorId ? { vendorId: sub.vendorId } : {}),
    ...(sub.serviceProviderId ? { serviceProviderId: sub.serviceProviderId } : {}),
    ownerColumns: [sub.riderId, sub.driverId, sub.vendorId, sub.serviceProviderId].filter(Boolean).length,
  };
}

/** Read a subscription's owner. Null when the row is missing or no owner user
 *  is found. Callers that require a well-formed row check `ownerColumns`. */
export async function subscriptionOwnerOf(db: Db, subscriptionId: string): Promise<SubscriptionOwner | null> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId }, select: SUBSCRIPTION_OWNER_SELECT });
  return sub ? ownerOfRow(sub) : null;
}

/** The mover's own user record (rider, else driver) as the caller selected it;
 *  null for a store's or a pro's subscription. Display names and contact numbers. */
export function moverUserOf<T>(sub: { rider?: { user: T } | null; driver?: { user: T } | null } | null | undefined): T | null {
  return sub?.rider?.user ?? sub?.driver?.user ?? null;
}

/** The paying person's own user record when no store pays: the mover's, else
 *  the pro's. Display names on receipts and finance rows (a store shows its
 *  own name instead). */
export function personUserOf<T>(sub: { rider?: { user: T } | null; driver?: { user: T } | null; serviceProvider?: { user: T } | null } | null | undefined): T | null {
  return moverUserOf(sub) ?? sub?.serviceProvider?.user ?? null;
}

/** [AX363-F2] The tenant that owns a subscription, by the one ownership rule
 *  the admin tenant scope uses: exactly one owner, a vendor (its tenant) or a
 *  rider, driver or pro (their user's tenant). Read explicitly, whatever query
 *  extension the caller's client carries. Null: missing, or ownership
 *  ambiguous; a caller comparing it to a tenant then fails closed. */
export async function subscriptionOwnerTenant(db: Db, subscriptionId: string): Promise<string | null> {
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      vendorId: true, riderId: true, driverId: true, serviceProviderId: true,
      vendor: { select: { tenantId: true } },
      rider: { select: { user: { select: { tenantId: true } } } },
      driver: { select: { user: { select: { tenantId: true } } } },
      serviceProvider: { select: { user: { select: { tenantId: true } } } },
    },
  });
  if (!sub) return null;
  if ([sub.vendorId, sub.riderId, sub.driverId, sub.serviceProviderId].filter((owner) => owner !== null).length !== 1) return null;
  return ownerTenantOf(sub);
}

/** The owner's tenant on a row already read: a store's own tenant, else the
 *  rider's, the driver's or the pro's user's. No exactly-one-owner check
 *  (callers that need one use subscriptionOwnerTenant). */
export function ownerTenantOf(sub: {
  vendor?: { tenantId: string } | null;
  rider?: { user: { tenantId: string } } | null;
  driver?: { user: { tenantId: string } } | null;
  serviceProvider?: { user: { tenantId: string } } | null;
}): string | null {
  return sub.vendor?.tenantId ?? sub.rider?.user.tenantId ?? sub.driver?.user.tenantId ?? sub.serviceProvider?.user.tenantId ?? null;
}

// ── SQL ─────────────────────────────────────────────────────────────────────
// For raw statements over `subscriptions s`. The aliases are fixed: r (riders),
// d (drivers), v (vendors), vo (vendor_owners), sp (service_providers, the
// pro), u (the paying user).

/** The owner rows of `subscriptions s`, all optional (LEFT JOIN). */
export const SUBSCRIPTION_OWNER_JOINS_SQL = Prisma.sql`
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    LEFT JOIN "vendors" v ON v."id" = s."vendorId"
    LEFT JOIN "vendor_owners" vo ON vo."id" = v."ownerId"
    LEFT JOIN "service_providers" sp ON sp."id" = s."serviceProviderId"`;

/** The paying user's id, in the payer order (after SUBSCRIPTION_OWNER_JOINS_SQL). */
export const SUBSCRIPTION_PAYER_USER_ID_SQL = Prisma.sql`COALESCE(r."userId", d."userId", vo."userId", sp."userId")`;

/** [F7] The owner rows plus the paying user as `u`, whose "tenantId" is the
 *  tenant the subscription's money belongs to (an inner join: a row with no
 *  payer drops out). subscriptionTenantInTx below is this same statement. */
export const subscriptionTenantSql = Prisma.sql`${SUBSCRIPTION_OWNER_JOINS_SQL}
    JOIN "users" u ON u."id" = ${SUBSCRIPTION_PAYER_USER_ID_SQL}`;

/** A condition on the owner rows: this person pays the subscription (any owner role). */
export function subscriptionPaidBySql(userId: string): Prisma.Sql {
  return Prisma.sql`(r."userId" = ${userId} OR d."userId" = ${userId} OR vo."userId" = ${userId} OR sp."userId" = ${userId})`;
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
    LEFT JOIN "service_providers" sp ON sp."id" = s."serviceProviderId"
    JOIN "users" u ON u."id" = COALESCE(r."userId", d."userId", vo."userId", sp."userId")
    WHERE s."id" = ${subscriptionId}
  `;
  const tenantId = rows[0]?.tenantId;
  if (!tenantId) throw new AppError(500, 'SUBSCRIPTION_TENANT_UNKNOWN', `Subscription ${subscriptionId} has no payer to take a tenant from.`);
  return tenantId;
}
