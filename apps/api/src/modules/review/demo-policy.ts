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
import type { TenantKind } from '@prisma/client';
import { AppError } from '../../utils/errors';

export const REVIEW_DEMO_NO_ORDERS = 'REVIEW_DEMO_NO_ORDERS';
export const REVIEW_DEMO_NO_ORDERS_MESSAGE =
  "This is Swift's App Review demo: these stores and menus are fictional, so orders can't be placed here. Nothing was charged and nobody was contacted.";
/** Taxi and parcel bookings: the fiction's drivers and riders take no real jobs. */
export const REVIEW_DEMO_NO_BOOKINGS_MESSAGE =
  "This is Swift's App Review demo: its drivers and riders are fictional, so rides and parcel deliveries can't be booked here. Nothing was charged and nobody was contacted.";

export const REVIEW_DEMO_NO_MONEY = 'REVIEW_DEMO_NO_MONEY';
export const REVIEW_DEMO_NO_MONEY_MESSAGE =
  "This is Swift's App Review demo: no money moves here, so there is no weekly fee to pay and no MMG pay link to set. Nothing was charged and nobody was contacted.";

export class ReviewDemoOrderRefusedError extends AppError {
  constructor(message: string = REVIEW_DEMO_NO_ORDERS_MESSAGE) {
    super(403, REVIEW_DEMO_NO_ORDERS, message);
    this.name = 'ReviewDemoOrderRefusedError';
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
