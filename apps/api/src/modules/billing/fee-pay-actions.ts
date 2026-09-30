import type { PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { log } from '../../utils/logger';
import { getMmgCheckoutProvider, type MmgCheckoutProvider } from '../../providers/mmg/mmg-checkout';
import { payInfo } from './agent-cash.service';
import { weeklyFeeAmount } from './subscription-fee';

// ---------------------------------------------------------------------------
// The ways a partner can pay the weekly fee IN THE APP, decided in one place
// (MMG-CHECKOUT-API.md section 3). The subscription payload, the checkout
// route and every fee notice read this; no client re-derives it.
//
// MMG_CHECKOUT is 'live' only when the server's MMG checkout is configured
// (MMG_CHECKOUT_ENABLED=1 with a complete configuration), the per-platform
// switch allows the platform, and the subscription can be paid. Otherwise it
// is 'off', and 'off' is hidden: never a disabled "coming soon". CARD stays
// 'off' until the card rail exists (PT-4).
// ---------------------------------------------------------------------------

export type ClientPlatform = 'ios' | 'android' | 'web' | 'unknown';

export type PayAction =
  | { id: 'MMG_CHECKOUT'; state: 'live'; amountGyd: number; currencyCode: 'GYD' }
  | { id: 'MMG_CHECKOUT'; state: 'off' }
  | { id: 'CARD'; state: 'off' };

/** The per-platform switch: {"ios": true, "android": true, "web": true}. */
export const FEE_CHECKOUT_PLATFORMS_KEY = 'billing.feeCheckout.platforms';
const SWITCH_TTL_MS = 60_000;
/** Paying rejoins a CHURNED account; PAUSED (billing stopped) and CANCELLED do not pay. */
const PAYABLE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CHURNED']);

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

let switchCache: { at: number; value: Record<string, unknown> | null } | null = null;
/** Tests reset the one-minute cache of the per-platform switch. */
export function resetFeeCheckoutSwitchCache(): void {
  switchCache = null;
}

/** A missing row, or a platform missing from it, is ON (owner ruling "3 b");
 *  only an explicit `false` switches a platform off. */
export async function feeCheckoutPlatforms(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<Record<'ios' | 'android' | 'web', boolean>> {
  const now = Date.now();
  if (!switchCache || now - switchCache.at > SWITCH_TTL_MS) {
    const row = await prisma.platformConfig.findUnique({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY } });
    const value = row?.value;
    switchCache = { at: now, value: value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null };
  }
  const on = (platform: string) => switchCache?.value?.[platform] !== false;
  return { ios: on('ios'), android: on('android'), web: on('web') };
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
  sub: PayableSub & Pick<Subscription, 'id'> & { type?: string },
  platform: ClientPlatform,
  checkout?: () => MmgCheckoutProvider,
): Promise<PayAction[]> {
  const live = await mmgCheckoutLive(prisma, sub, platform, checkout);
  const mmg: PayAction = live
    ? { id: 'MMG_CHECKOUT', state: 'live', amountGyd: checkoutAmountGyd(await payInfo(prisma, sub)), currencyCode: 'GYD' }
    : { id: 'MMG_CHECKOUT', state: 'off' };
  return [mmg, { id: 'CARD', state: 'off' }];
}
