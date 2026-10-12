import type { PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { log } from '../../utils/logger';
import { cardEnrollEnabled, cardRailKilled, cardRailV2Enabled, cardSimulatorLiveEnabled, cardSimulatorSubscriptions } from '../../utils/card-rail';
import { SIMULATOR_PAGE } from '../../providers/card/simulator-provider';
import { OPERABLE_STATUSES } from '../subscription/operate-gate';
import { subscriptionPayer } from '../subscription/mover-fee-authority';
import { weeklyFeeAmount } from './subscription-fee';
import { readFeePaymentDecision } from './fee-payment-authority';
import type { ClientPlatform } from './fee-pay-actions';
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
//                        a REAL provider: the simulator makes CARD live only
//                        on a test server that says so (CARD_RAIL_SIMULATOR_LIVE,
//                        refused in production), and then labelled as a test.
//                        `off` is hidden, never a disabled "coming soon".
// ---------------------------------------------------------------------------

/** What a card looks like on the Pay screen: brand, last 4, expiry, status [C9]. */
export type CardView = PaymentInstrumentDto;

export type CardPayAction =
  | { id: 'CARD'; state: 'off' }
  | {
      id: 'CARD';
      state: 'live';
      /** Exactly what a Pay-now session charges right now (the server's price). */
      payNow: { amount: number; currencyCode: string };
      /** May the partner save a card for the weekly fee? False unless the
       *  provider can charge a saved card without the partner present AND
       *  saving cards is switched on (CARD_RAIL_ENROLL). */
      addCard: boolean;
      /** The ACTIVE card, if any. */
      cardOnFile: CardView | null;
      /** True when the card choice is a TEST (the simulator on a test server):
       *  every screen shows testModeLabel. */
      testMode: boolean;
      testModeLabel?: string;
    };

export const CARD_OFF: CardPayAction = { id: 'CARD', state: 'off' };

/**
 * The per-platform switch for card payment, its own key so the card door can
 * be closed on one platform without touching MMG's: {"ios": bool, "android":
 * bool, "web": bool}. [Owner 6 Oct · Apple 3.1.1] iOS is OFF unless the row
 * says `"ios": true`; Android and web are ON unless the row says `false`.
 * [DS633, as MMG's switch] Only a real boolean counts: any other value for a
 * platform switches that platform OFF, and a row that is not an object
 * switches every platform OFF, each with a warning, so a kill written with
 * the wrong type still kills.
 */
export const CARD_CHECKOUT_PLATFORMS_KEY = 'billing.cardCheckout.platforms';
const SWITCH_TTL_MS = 60_000;
const PLATFORMS = ['ios', 'android', 'web'] as const;
type PlatformSwitches = Record<(typeof PLATFORMS)[number], boolean>;
/** With no row, or a platform missing from the row. */
const SWITCH_DEFAULTS: PlatformSwitches = { ios: false, android: true, web: true };

/** Paying rejoins a CHURNED account; PAUSED (billing stopped) and CANCELLED do not pay. */
const PAYABLE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([...OPERABLE_STATUSES, 'SUSPENDED', 'CHURNED']);

let switchCache: { at: number; switches: PlatformSwitches } | null = null;
/** Tests reset the one-minute cache of the per-platform switch. */
export function resetCardCheckoutSwitchCache(): void {
  switchCache = null;
}

function platformSwitches(row: { value: unknown } | null): PlatformSwitches {
  if (!row) return { ...SWITCH_DEFAULTS };
  const value = row.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    log().warn({ key: CARD_CHECKOUT_PLATFORMS_KEY }, '[PT-2] the card per-platform switch is not an object of true/false values; paying by card is OFF on every platform until it is corrected');
    return { ios: false, android: false, web: false };
  }
  const switches = { ...SWITCH_DEFAULTS };
  for (const platform of PLATFORMS) {
    if (!Object.prototype.hasOwnProperty.call(value, platform)) continue;
    const on = (value as Record<string, unknown>)[platform];
    if (typeof on === 'boolean') {
      switches[platform] = on;
    } else {
      switches[platform] = false;
      log().warn({ key: CARD_CHECKOUT_PLATFORMS_KEY, platform }, '[PT-2] a card per-platform switch value is not true or false; paying by card is OFF on that platform until it is corrected');
    }
  }
  return switches;
}

export async function cardCheckoutPlatforms(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<PlatformSwitches> {
  const now = Date.now();
  if (!switchCache || now - switchCache.at > SWITCH_TTL_MS) {
    const row = await prisma.platformConfig.findUnique({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY } });
    switchCache = { at: now, switches: platformSwitches(row) };
  }
  return { ...switchCache.switches };
}

export type CardSessionsDecision =
  | { allowed: true; provider: CardRailProvider }
  | { allowed: false; reason: 'FLAG_OFF' | 'KILLED' | 'NO_PROVIDER' | 'NOT_TEST_SUBSCRIPTION' | 'PLATFORM_OFF' | 'NOT_PAYABLE' | 'NOT_PRODUCTION_PAYER' };

type PayableSub = Pick<Subscription, 'id' | 'status' | 'feeWaived' | 'weeklyRate' | 'customRate'>;

/**
 * THE rule for opening a card page. In order: the flag, the kill switch, a
 * provider that builds from this server's configuration, the platform switch
 * (an unknown platform counts only when every platform is on), a payable
 * subscription with a fee above zero, and a payer in a production tenant (the
 * store-review demo and the crawler never reach a card page, test or real).
 * [Review S2] The simulator — no real money, yet its "Approve" books a week —
 * serves only the TEST subscriptions listed in CARD_RAIL_SIMULATOR_SUBSCRIPTIONS.
 */
export async function cardSessionsAllowed(
  prisma: PrismaClient,
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
  if (provider.simulator && !cardSimulatorSubscriptions().has(sub.id)) return { allowed: false, reason: 'NOT_TEST_SUBSCRIPTION' };
  const switches = await cardCheckoutPlatforms(prisma);
  const platformOn = platform === 'unknown' ? switches.ios && switches.android && switches.web : switches[platform];
  if (!platformOn) return { allowed: false, reason: 'PLATFORM_OFF' };
  if (!PAYABLE.has(sub.status) || sub.feeWaived || !(weeklyFeeAmount(sub) > 0)) return { allowed: false, reason: 'NOT_PAYABLE' };
  if (!(await payerIsProduction(prisma, sub.id))) return { allowed: false, reason: 'NOT_PRODUCTION_PAYER' };
  return { allowed: true, provider };
}

/** Whether the subscription's payer (#1393's: the rider's or driver's user, or
 *  the store owner's) is in a PRODUCTION tenant. Unknown payer: no. */
async function payerIsProduction(prisma: PrismaClient, subscriptionId: string): Promise<boolean> {
  const payer = await subscriptionPayer(prisma, subscriptionId).catch(() => null);
  if (!payer) return false;
  const tenant = await prisma.tenant.findUnique({ where: { id: payer.tenantId }, select: { kind: true } });
  return tenant?.kind === 'PRODUCTION';
}

/**
 * The CARD entry of payActions. `live` needs cardSessionsAllowed AND a real
 * provider (never the simulator) AND a price the server can quote now AND —
 * exactly as MMG_CHECKOUT — #1393's read-only decision allowing a NEW payment
 * (none of this fee's payments is being confirmed, and the billing clock
 * covers the subscription). Reading it never opens a page, takes a lock or
 * changes anything.
 */
export async function cardPayAction(
  prisma: PrismaClient,
  quote: (subscriptionId: string) => Promise<{ amount: number; currencyCode: string }>,
  sub: PayableSub,
  platform: ClientPlatform,
  rail: CardRailSource,
): Promise<CardPayAction> {
  const decision = await cardSessionsAllowed(prisma, sub, platform, rail);
  if (!decision.allowed || (decision.provider.simulator && !cardSimulatorLiveEnabled())) return CARD_OFF;
  let payNow: { amount: number; currencyCode: string };
  try {
    const priced = await quote(sub.id);
    payNow = { amount: priced.amount, currencyCode: priced.currencyCode };
  } catch {
    return CARD_OFF; // nothing to pay (waived, zero), under review, or no price: no button
  }
  if (!(await readFeePaymentDecision(prisma, sub.id)).allowed) return CARD_OFF;
  const addCard = decision.provider.savesCards && cardEnrollEnabled();
  const cardOnFile = addCard
    ? await prisma.paymentInstrument.findFirst({ where: { subscriptionId: sub.id, status: 'ACTIVE' }, select: INSTRUMENT_DTO_SELECT })
    : null;
  const testModeLabel = decision.provider.simulator ? SIMULATOR_PAGE.testModeLabel : undefined;
  return { id: 'CARD', state: 'live', payNow, addCard, cardOnFile, testMode: testModeLabel !== undefined, ...(testModeLabel ? { testModeLabel } : {}) };
}
