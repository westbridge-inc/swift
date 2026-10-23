import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// The per-platform switch of the in-app MMG checkout for the weekly fee
// (owner ruling "3 b"): one platform_config row, {"ios": true, "android":
// true, "web": true}. Two readers decide from it:
//   - fee-pay-actions.ts: may this partner pay with MMG in the app on this
//     platform (the button, the checkout route, every fee notice);
//   - fee-pause.ts: is the MMG checkout a way to pay at all, for the fee
//     pause (only with EVERY platform on: a partner's app may be any of them).
// A leaf module, so the fee pause can read it without importing the pay
// actions' module graph.
// ---------------------------------------------------------------------------

/** The per-platform switch: {"ios": true, "android": true, "web": true}. */
export const FEE_CHECKOUT_PLATFORMS_KEY = 'billing.feeCheckout.platforms';

export type PlatformSwitches = Record<'ios' | 'android' | 'web', boolean>;
const PLATFORMS = ['ios', 'android', 'web'] as const;

/** The switch row as read: a missing row, or a platform missing from it, is
 *  ON (owner ruling "3 b"). [DS633] Only a real boolean counts: any other
 *  value for a platform (the string "false" included) switches that platform
 *  OFF, and a row that is not an object switches every platform OFF, each
 *  with a warning, so a kill switch written with the wrong type still kills. */
export function platformSwitches(row: { value: unknown } | null): PlatformSwitches {
  if (!row) return { ios: true, android: true, web: true };
  const value = row.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    log().warn({ key: FEE_CHECKOUT_PLATFORMS_KEY }, '[MMG checkout] the per-platform switch is not an object of true/false values; the MMG checkout is OFF on every platform until it is corrected');
    return { ios: false, android: false, web: false };
  }
  const switches = { ios: true, android: true, web: true };
  for (const platform of PLATFORMS) {
    if (!Object.prototype.hasOwnProperty.call(value, platform)) continue;
    const on = (value as Record<string, unknown>)[platform];
    if (typeof on === 'boolean') {
      switches[platform] = on;
    } else {
      switches[platform] = false;
      log().warn({ key: FEE_CHECKOUT_PLATFORMS_KEY, platform }, '[MMG checkout] a per-platform switch value is not true or false; the MMG checkout is OFF on that platform until it is corrected');
    }
  }
  return switches;
}

/** [fee pause] Is the MMG checkout switched on for EVERY platform? Read fresh
 *  (never the pay actions' one-minute cache): the fee pause is never cached. */
export async function feeCheckoutEveryPlatformOn(db: Pick<PrismaClient, 'platformConfig'>): Promise<boolean> {
  const row = await db.platformConfig.findUnique({ where: { key: FEE_CHECKOUT_PLATFORMS_KEY }, select: { value: true } });
  const switches = platformSwitches(row);
  return switches.ios && switches.android && switches.web;
}
