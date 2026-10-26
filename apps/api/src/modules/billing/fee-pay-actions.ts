import type { PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { log } from '../../utils/logger';
import { getMmgCheckoutProvider, type MmgCheckoutProvider } from '../../providers/mmg/mmg-checkout';
import { payInfo } from './agent-cash.service';
import { payAheadAllows } from './pay-ahead';
import { weeklyFeeAmount } from './subscription-fee';
import { OPERABLE_STATUSES } from '../subscription/operate-gate';
import type { CardPayAction } from './card-pay-action';
import { FEE_CHECKOUT_PLATFORMS_KEY, platformSwitches, type PlatformSwitches } from './fee-checkout-switch';

// ---------------------------------------------------------------------------
// The ways a partner can pay the weekly fee IN THE APP, decided in one place
// (MMG-CHECKOUT-API.md section 3). The subscription payload, the checkout
// route and every fee notice read this; no client re-derives it.
//
// MMG_CHECKOUT is 'live' only when the server's MMG checkout is configured
// (MMG_CHECKOUT_ENABLED=1 with a complete configuration), the per-platform
// switch allows the platform, and the subscription can be paid. Otherwise it
// is 'off', and 'off' is hidden: never a disabled "coming soon". CARD is
// decided by card-pay-action.ts (CARD-CHECKOUT-API.md section 3); here it is
// 'off', and each family's subscription payload puts the card rail's own
// answer in its place (card-rail.routes.ts withCardPayAction).
// ---------------------------------------------------------------------------

export type ClientPlatform = 'ios' | 'android' | 'web' | 'unknown';

export type PayAction =
  | { id: 'MMG_CHECKOUT'; state: 'live'; amountGyd: number; currencyCode: 'GYD' }
  | { id: 'MMG_CHECKOUT'; state: 'off' }
  | CardPayAction;

export { FEE_CHECKOUT_PLATFORMS_KEY };
/** [MMG reopen] Its own per-platform switch for "Back to MMG's page" (handing
 *  the SAME open checkout page out again). OFF when the row or a platform is
 *  missing: it stays off in production until UAT shows what MMG does when an
 *  already-used checkout page is opened again (MMG-CHECKOUT-API.md section 3). */
export const FEE_CHECKOUT_REOPEN_PLATFORMS_KEY = 'billing.feeCheckout.reopen.platforms';
const SWITCH_TTL_MS = 60_000;
/** Paying rejoins a CHURNED account; PAUSED (billing stopped) and CANCELLED do not pay. */
const PAYABLE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([...OPERABLE_STATUSES, 'SUSPENDED', 'CHURNED']);

type PayableSub = Pick<Subscription, 'status' | 'feeWaived' | 'currencyCode' | 'weeklyRate' | 'customRate'>;

/** The platform the client says it is (the existing `x-client-platform` header convention). */
export function clientPlatform(headers: Record<string, unknown>): ClientPlatform {
  const h = String(headers['x-client-platform'] ?? '').toLowerCase();
  return h === 'ios' || h === 'android' || h === 'web' ? h : 'unknown';
}

/** [I1] What a checkout charges: the amount due rounded UP to whole GYD (MMG
 *  takes whole dollars; the part of a dollar above the due banks as credit),
 *  or one week's fee when nothing is due. */
export function checkoutAmountGyd(fee: { weeklyFeeGyd: number; amountDueGyd: number }): number {
  const owed = fee.amountDueGyd > 0 ? fee.amountDueGyd : fee.weeklyFeeGyd;
  return Math.ceil(Math.round(owed * 100) / 100);
}

let switchCache: { at: number; switches: PlatformSwitches } | null = null;
let reopenSwitchCache: { at: number; switches: PlatformSwitches } | null = null;
/** Tests reset the one-minute caches of the per-platform switches (Pay and reopen). */
export function resetFeeCheckoutSwitchCache(): void {
  switchCache = null;
  reopenSwitchCache = null;
}

/** [MMG reopen] The reopen switch row as read. Unlike the pay switch
 *  (fee-checkout-switch.ts: missing = ON, owner ruling "3 b"), a missing row
 *  or platform is OFF. Only a real boolean counts: any other value for a
 *  platform switches it OFF, and a row that is not an object switches every
 *  platform OFF, each with a warning. */
function reopenPlatformSwitches(row: { value: unknown } | null): PlatformSwitches {
  if (!row) return { ios: false, android: false, web: false };
  const value = row.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    log().warn({ key: FEE_CHECKOUT_REOPEN_PLATFORMS_KEY }, "[MMG checkout] the reopen per-platform switch is not an object of true/false values; reopening an open MMG checkout (Back to MMG's page) is OFF on every platform until it is corrected");
    return { ios: false, android: false, web: false };
  }
  const switches = { ios: false, android: false, web: false };
  for (const platform of ['ios', 'android', 'web'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, platform)) continue;
    const on = (value as Record<string, unknown>)[platform];
    if (typeof on === 'boolean') {
      switches[platform] = on;
    } else {
      log().warn({ key: FEE_CHECKOUT_REOPEN_PLATFORMS_KEY, platform }, "[MMG checkout] a reopen per-platform switch value is not true or false; reopening an open MMG checkout (Back to MMG's page) is OFF on that platform until it is corrected");
    }
  }
  return switches;
}

/** A missing row, or a platform missing from it, is ON (owner ruling "3 b");
 *  `false`, or any value that is not a real boolean, switches a platform off.
 *  The row is read at most once a minute (platformSwitches: fee-checkout-switch.ts). */
export async function feeCheckoutPlatforms(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<Record<'ios' | 'android' | 'web', boolean>> {
  const now = Date.now();
  if (!switchCache || now - switchCache.at > SWITCH_TTL_MS) {
    const row = await prisma.platformConfig.findUnique({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
    switchCache = { at: now, switches: platformSwitches(row) };
  }
  return { ...switchCache.switches };
}

/** [MMG reopen] May "Back to MMG's page" be offered and honoured on this
 *  platform? Read at most once a minute; a missing row or platform is OFF, and
 *  only the JSON boolean `true` turns a platform on. An unknown platform counts
 *  only when every platform is on. */
export async function mmgReopenSwitchedOn(prisma: Pick<PrismaClient, 'platformConfig'>, platform: ClientPlatform): Promise<boolean> {
  const now = Date.now();
  if (!reopenSwitchCache || now - reopenSwitchCache.at > SWITCH_TTL_MS) {
    const row = await prisma.platformConfig.findUnique({ where: { key: FEE_CHECKOUT_REOPEN_PLATFORMS_KEY } });
    reopenSwitchCache = { at: now, switches: reopenPlatformSwitches(row) };
  }
  const switches = reopenSwitchCache.switches;
  return platform === 'unknown' ? switches.ios && switches.android && switches.web : switches[platform];
}

/**
 * THE rule: may this subscription pay with MMG in the app on this platform?
 * An unknown platform counts as live only if every platform is switched on,
 * so a notice (read anywhere) never promises a button a platform hides.
 */
export async function mmgCheckoutLive(
  prisma: Pick<PrismaClient, 'platformConfig'>,
  sub: PayableSub,
  platform: ClientPlatform,
  checkout: () => MmgCheckoutProvider = () => getMmgCheckoutProvider(),
): Promise<boolean> {
  if (!PAYABLE.has(sub.status) || sub.feeWaived || sub.currencyCode !== 'GYD') return false;
  if (!(weeklyFeeAmount(sub) > 0)) return false;
  let provider: MmgCheckoutProvider;
  try {
    provider = checkout();
  } catch (err) {
    log().error({ err }, '[MMG checkout] the checkout configuration could not be loaded; the pay action is off');
    return false;
  }
  if (provider.driver === 'disabled') return false;
  const switches = await feeCheckoutPlatforms(prisma);
  return platform === 'unknown' ? switches.ios && switches.android && switches.web : switches[platform];
}

/** payActions for the subscription payload, in display order. */
export async function feePayActions(
  prisma: PrismaClient,
  sub: PayableSub & Pick<Subscription, 'id' | 'nextBillingDate'> & { type?: string },
  platform: ClientPlatform,
  checkout?: () => MmgCheckoutProvider,
): Promise<PayAction[]> {
  const live = await mmgCheckoutLive(prisma, sub, platform, checkout);
  const amountGyd = live ? checkoutAmountGyd(await payInfo(prisma, sub)) : 0;
  // [owner #62 · DS1114 S3] One week at a time: once the coming week is paid the
  // checkout could only refuse, so there is no button (the screen still says
  // when the next fee is due).
  const mmg: PayAction = live && await payAheadAllows(prisma, sub.id, amountGyd, new Date())
    ? { id: 'MMG_CHECKOUT', state: 'live', amountGyd, currencyCode: 'GYD' }
    : { id: 'MMG_CHECKOUT', state: 'off' };
  return [mmg, { id: 'CARD', state: 'off' }];
}
