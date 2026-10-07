import type { PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { log } from '../../utils/logger';
import { cardRailKilled, cardRailV2Enabled } from '../../utils/card-rail';
import { OPERABLE_STATUSES } from '../subscription/operate-gate';
import { weeklyFeeAmount } from './subscription-fee';
import { INSTRUMENT_DTO_SELECT, type PaymentInstrumentDto } from './card-rail.service';
import type { CardRailProvider, CardRailSource } from '../../providers/card/card-provider';

// ---------------------------------------------------------------------------
// [PT-2] May this partner pay the weekly fee by card, here, now? Decided in
// one place (CARD-CHECKOUT-API.md section 3). The card routes and the CARD
// entry of the subscription's payActions read this; no client re-derives it.
//
// Two answers:
//   cardSessionsAllowed  may a card page be opened at all (the routes ask it
//                        before any key, price or page). The simulator passes
//                        it on a test server, so the whole loop can be driven.
//   cardPayAction        what the Pay screen shows. `live` additionally needs
//                        a REAL provider: the simulator never makes CARD live,
//                        so no normal build shows a card button on a test
//                        page. `off` is hidden, never a disabled "coming soon".
// ---------------------------------------------------------------------------

export type ClientPlatform = 'ios' | 'android' | 'web' | 'unknown';

/** What a card looks like on the Pay screen: brand, last 4, expiry, status [C9]. */
export type CardView = PaymentInstrumentDto;

export type CardPayAction =
  | { id: 'CARD'; state: 'off' }
  | {
      id: 'CARD';
      state: 'live';
      /** Exactly what a Pay-now session charges right now (the server's price). */
      payNow: { amount: number; currencyCode: string };
      /** May the partner save a card for the weekly fee? False until the
       *  provider documents charging a saved card without the partner present. */
      addCard: boolean;
      /** The ACTIVE card, if any. */
      cardOnFile: CardView | null;
    };

export const CARD_OFF: CardPayAction = { id: 'CARD', state: 'off' };

/**
 * The per-platform switch for card payment, its own key so the card door can
 * be closed on one platform without touching MMG's: {"ios": bool, "android":
 * bool, "web": bool}. [Brief 4 Oct · Apple 3.1.1] iOS is OFF unless the row
 * says `"ios": true`; Android and web are ON unless the row says `false`.
 */
export const CARD_CHECKOUT_PLATFORMS_KEY = 'billing.cardCheckout.platforms';
const SWITCH_TTL_MS = 60_000;

/** Paying rejoins a CHURNED account; PAUSED (billing stopped) and CANCELLED do not pay. */
const PAYABLE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([...OPERABLE_STATUSES, 'SUSPENDED', 'CHURNED']);

/** The platform the client says it is (the `x-client-platform` header convention). */
export function clientPlatform(headers: Record<string, unknown>): ClientPlatform {
  const h = String(headers['x-client-platform'] ?? '').toLowerCase();
  return h === 'ios' || h === 'android' || h === 'web' ? h : 'unknown';
}

let switchCache: { at: number; value: Record<string, unknown> | null } | null = null;
/** Tests reset the one-minute cache of the per-platform switch. */
export function resetCardCheckoutSwitchCache(): void {
  switchCache = null;
}

export async function cardCheckoutPlatforms(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<Record<'ios' | 'android' | 'web', boolean>> {
  const now = Date.now();
  if (!switchCache || now - switchCache.at > SWITCH_TTL_MS) {
    const row = await prisma.platformConfig.findUnique({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY } });
    const value = row?.value;
    switchCache = { at: now, value: value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null };
  }
  const v = switchCache.value;
  return { ios: v?.['ios'] === true, android: v?.['android'] !== false, web: v?.['web'] !== false };
}

export type CardSessionsDecision =
  | { allowed: true; provider: CardRailProvider }
  | { allowed: false; reason: 'FLAG_OFF' | 'KILLED' | 'NO_PROVIDER' | 'PLATFORM_OFF' | 'NOT_PAYABLE' | 'NOT_PRODUCTION_PAYER' };

type PayableSub = Pick<Subscription, 'id' | 'status' | 'feeWaived' | 'weeklyRate' | 'customRate'>;

/**
 * THE rule for opening a card page. In order: the flag, the kill switch, a
 * provider that builds from this server's configuration, the platform switch
 * (an unknown platform counts only when every platform is on), a payable
 * subscription with a fee above zero, and — for a REAL provider — a payer in
 * a production tenant (the store-review demo never reaches a real card page).
 */
export async function cardSessionsAllowed(
  prisma: Pick<PrismaClient, 'platformConfig' | 'subscription' | 'tenant'>,
  sub: PayableSub,
  platform: ClientPlatform,
  rail: CardRailSource,
): Promise<CardSessionsDecision> {
  if (!cardRailV2Enabled()) return { allowed: false, reason: 'FLAG_OFF' };
  if (cardRailKilled()) return { allowed: false, reason: 'KILLED' };
  let provider: CardRailProvider;
  try {
    provider = rail();
  } catch (err) {
    log().error({ err }, '[PT-2] the card rail configuration could not be loaded; card payment is off');
    return { allowed: false, reason: 'NO_PROVIDER' };
  }
  const switches = await cardCheckoutPlatforms(prisma);
  const platformOn = platform === 'unknown' ? switches.ios && switches.android && switches.web : switches[platform];
  if (!platformOn) return { allowed: false, reason: 'PLATFORM_OFF' };
  if (!PAYABLE.has(sub.status) || sub.feeWaived || !(weeklyFeeAmount(sub) > 0)) return { allowed: false, reason: 'NOT_PAYABLE' };
  if (!provider.simulator && !(await payerIsProduction(prisma, sub.id))) return { allowed: false, reason: 'NOT_PRODUCTION_PAYER' };
  return { allowed: true, provider };
}

/** Whether the subscription's payer (rider, driver or store owner) is in a PRODUCTION tenant. */
async function payerIsProduction(prisma: Pick<PrismaClient, 'subscription' | 'tenant'>, subscriptionId: string): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      rider: { select: { user: { select: { tenantId: true } } } },
      driver: { select: { user: { select: { tenantId: true } } } },
      vendor: { select: { owner: { select: { user: { select: { tenantId: true } } } } } },
    },
  });
  const tenantId = sub?.rider?.user.tenantId ?? sub?.driver?.user.tenantId ?? sub?.vendor?.owner.user.tenantId;
  if (!tenantId) return false;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { kind: true } });
  return tenant?.kind === 'PRODUCTION';
}

/**
 * The CARD entry of payActions. `live` needs cardSessionsAllowed AND a real
 * provider (never the simulator) AND a price the server can quote now.
 * Reading it never opens a page, takes a lock or changes anything.
 */
export async function cardPayAction(
  prisma: PrismaClient,
  quote: (subscriptionId: string) => Promise<{ amount: number; currencyCode: string }>,
  sub: PayableSub,
  platform: ClientPlatform,
  rail: CardRailSource,
): Promise<CardPayAction> {
  const decision = await cardSessionsAllowed(prisma, sub, platform, rail);
  if (!decision.allowed || decision.provider.simulator) return CARD_OFF;
  let payNow: { amount: number; currencyCode: string };
  try {
    const priced = await quote(sub.id);
    payNow = { amount: priced.amount, currencyCode: priced.currencyCode };
  } catch {
    return CARD_OFF; // nothing to pay (waived, zero) or no price: no button
  }
  const cardOnFile = await prisma.paymentInstrument.findFirst({
    where: { subscriptionId: sub.id, status: 'ACTIVE' },
    select: INSTRUMENT_DTO_SELECT,
  });
  // [PT-2] No provider in this build charges a saved card each week without
  // the partner present (PowerTranz's guide v2.7 documents no such charge):
  // Add card stays closed and the screen offers Pay now only.
  return { id: 'CARD', state: 'live', payNow, addCard: false, cardOnFile };
}
