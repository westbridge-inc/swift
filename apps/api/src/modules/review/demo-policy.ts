/**
 * [STA-1 DL-5] The store-review fiction has no money rail and moves nothing.
 *
 * A reviewer signed in to a REVIEW tenant browses the content pack's
 * fictional stores, fills a cart and reaches checkout like any customer. The
 * order itself is refused HERE, before anything is written: no order, no
 * outbox row, no vendor alert ladder (whose last rung is an SMS), no MMG
 * hand-off, no dispatch. The words are the ones the app shows under the
 * Place-order button.
 *
 * [REVIEW-PARTNER] The same rule covers the fiction's rider and taxi driver
 * (review/partner-pack.ts). Their job board is honestly EMPTY: a taxi or a
 * parcel booked inside the fiction is refused like checkout, so no job can
 * ever be created for them to see, and production dispatch never reaches
 * them (it stays inside the order's own tenant). They owe no weekly fee
 * because they can earn nothing: no subscription row is ever written for
 * them, exactly as the pack's stores hold none, and every fee or MMG surface
 * answers with the refusal below before any step-up, provider or SMS.
 */
import type { PrismaClient, TenantKind } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { runWithoutTenant } from '../../plugins/tenant-context';

export const REVIEW_DEMO_NO_ORDERS = 'REVIEW_DEMO_NO_ORDERS';
export const REVIEW_DEMO_NO_ORDERS_MESSAGE =
  "This is Swift's App Review demo: these stores and menus are fictional, so orders can't be placed here. Nothing was charged and nobody was contacted.";
/** Taxi and parcel bookings: the fiction's drivers and riders take no real jobs. */
export const REVIEW_DEMO_NO_BOOKINGS_MESSAGE =
  "This is Swift's App Review demo: its drivers and riders are fictional, so rides and parcel deliveries can't be booked here. Nothing was charged and nobody was contacted.";

export const REVIEW_DEMO_NO_MONEY = 'REVIEW_DEMO_NO_MONEY';
export const REVIEW_DEMO_NO_MONEY_MESSAGE =
  "This is Swift's App Review demo: no money moves here, so there is no weekly fee to pay and no MMG pay link to set. Nothing was charged and nobody was contacted.";

/** [REVIEW-PARTNER] A demo login keeps the role it was minted with: becoming a store, an
 *  advertiser or a service provider, or swapping vehicle class, opens money surfaces and pages
 *  the platform's admins — none of which the fiction may reach. */
export const REVIEW_DEMO_NO_NEW_ROLES = 'REVIEW_DEMO_NO_NEW_ROLES';
export const REVIEW_DEMO_NO_NEW_ROLES_MESSAGE =
  "This is Swift's App Review demo: its logins are a customer, a rider and a driver, and they can't sign up as a store, advertiser or service provider or change vehicle here. Nothing was changed and nobody was contacted.";

export class ReviewDemoRoleRefusedError extends AppError {
  constructor() {
    super(403, REVIEW_DEMO_NO_NEW_ROLES, REVIEW_DEMO_NO_NEW_ROLES_MESSAGE);
    this.name = 'ReviewDemoRoleRefusedError';
  }
}

export class ReviewDemoOrderRefusedError extends AppError {
  constructor(message: string = REVIEW_DEMO_NO_ORDERS_MESSAGE) {
    super(403, REVIEW_DEMO_NO_ORDERS, message);
    this.name = 'ReviewDemoOrderRefusedError';
  }
}

export const REVIEW_DEMO_NO_SOS = 'REVIEW_DEMO_NO_SOS';
export const REVIEW_DEMO_NO_SOS_MESSAGE =
  "This is Swift's App Review demo, so nobody was alerted: no safety team, operator or emergency contact. In a real emergency, call your local emergency number.";

/** [REVIEW-PARTNER] SOS in the fiction: an honest, demo-only answer; nothing is written and nobody is paged. */
export class ReviewDemoSosError extends AppError {
  constructor() {
    super(403, REVIEW_DEMO_NO_SOS, REVIEW_DEMO_NO_SOS_MESSAGE);
    this.name = 'ReviewDemoSosError';
  }
}

export class ReviewDemoMoneyRefusedError extends AppError {
  constructor() {
    super(403, REVIEW_DEMO_NO_MONEY, REVIEW_DEMO_NO_MONEY_MESSAGE);
    this.name = 'ReviewDemoMoneyRefusedError';
  }
}

/**
 * The missing-subscription-row policy for a partner's go-online gate
 * (operate-gate.ts: "a missing subscription row is caller policy"). The
 * fiction never holds a subscription row — it has no money rail to bill
 * on — so in a REVIEW tenant a missing row is the honest normal and operates.
 * Every other tenant keeps the caller's own policy, unchanged.
 */
export function weeklyFeeMissingRowPolicy(
  kind: TenantKind | null | undefined,
  otherwise: 'BLOCK' | 'GRANDFATHER',
): 'BLOCK' | 'GRANDFATHER' {
  return kind === 'REVIEW' ? 'GRANDFATHER' : otherwise;
}

/** [REVIEW-PARTNER] Is this account a person of the store-review fiction? A system read (the
 *  answer must not depend on whose request it runs inside); a missing account is not the fiction. */
export async function isReviewAccount(prisma: Pick<PrismaClient, 'user'>, userId: string): Promise<boolean> {
  const user = await runWithoutTenant(
    () => prisma.user.findUnique({ where: { id: userId }, select: { tenant: { select: { kind: true } } } }),
    'review-account-seal',
  );
  return user?.tenant.kind === 'REVIEW';
}

/** [REVIEW-PARTNER] The role-grant seal: a demo account never gains a role or a membership. */
export async function refuseReviewAccountRoleGrant(prisma: Pick<PrismaClient, 'user'>, ...userIds: string[]): Promise<void> {
  for (const userId of userIds) if (await isReviewAccount(prisma, userId)) throw new ReviewDemoRoleRefusedError();
}

/** [REVIEW-PARTNER] Does this weekly-fee subscription belong to the store-review fiction? (Its rider, driver or store.) */
export async function isReviewSubscription(prisma: Pick<PrismaClient, 'subscription'>, subscriptionId: string): Promise<boolean> {
  const sub = await runWithoutTenant(
    () => prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        rider: { select: { user: { select: { tenant: { select: { kind: true } } } } } },
        driver: { select: { user: { select: { tenant: { select: { kind: true } } } } } },
        vendor: { select: { tenant: { select: { kind: true } } } },
      },
    }),
    'review-fee-seal',
  );
  const kind = sub?.rider?.user?.tenant?.kind ?? sub?.driver?.user?.tenant?.kind ?? sub?.vendor?.tenant?.kind;
  return kind === 'REVIEW';
}
