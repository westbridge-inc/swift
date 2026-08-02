/**
 * The haptics map (design-100× Part 9.5) — the WHOLE map; nothing else in the
 * app vibrates. Semantic events only, so call sites read as intent:
 *
 *   select  — tab switch, option/chip select, stepper tick        (light)
 *   commit  — Place order press, Accept order/ride, Go online     (medium)
 *   success — order placed, PIN accepted, payment confirmed
 *   warn    — hold at 0:30, item-unavailable notice arrives
 *   failure — wrong PIN, failed action
 *
 * Never on scroll, keystrokes, or passive events; decorative haptics are a
 * Part 14 violation. The expo-haptics native module is required lazily and
 * guarded: on a stale dev-client binary (or web) every call is a silent no-op
 * instead of a startup crash (the netinfo lesson, PR #190).
 */
type HapticsModule = typeof import('expo-haptics');

let mod: HapticsModule | null | undefined;

function haptics(): HapticsModule | null {
  if (mod === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('expo-haptics') as HapticsModule;
    } catch {
      mod = null;
    }
  }
  return mod;
}

const fire = (run: (h: HapticsModule) => Promise<void>) => {
  const h = haptics();
  if (!h) return;
  run(h).catch(() => {});
};

export const haptic = {
  /** Light tick — tab switch, chip/option select, quantity stepper. */
  select: () => fire((h) => h.selectionAsync()),
  /** Medium impact — the commit press: Place order, Accept, Go online. */
  commit: () => fire((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium)),
  /** The big moments confirmed: order placed, PIN accepted, payment confirmed. */
  success: () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Success)),
  /** Hold at 0:30, item-unavailable arrives. */
  warn: () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Warning)),
  /** Wrong PIN, failed action. */
  failure: () => fire((h) => h.notificationAsync(h.NotificationFeedbackType.Error)),
};
