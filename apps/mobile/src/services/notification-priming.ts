import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

// Permission priming [first-open spec 2.5, SO-5]: no permission dialogs at
// boot — notifications ask at the first moment they're obviously useful,
// with a one-line priming card first. The OS only grants one real prompt,
// so a single durable asked-flag guards it; already-granted users register
// silently at session start (services/push registerIfGranted) and never see
// a card. A denied permission always leaves the app fully working.

export type PrimeMoment = 'customer_order' | 'driver_application' | 'store_created';

/** One line each, in-voice (F-30/F-31; the store line follows the family). */
export const PRIME_COPY: Record<PrimeMoment, string> = {
  customer_order: "We'll only ping you about your orders",
  driver_application: 'Job offers arrive as notifications — this is how you earn',
  store_created: 'Order alerts arrive as notifications — never miss a sale',
};

const store = new MMKV({ id: 'swift-notification-priming' });
const KEY_ASKED = 'priming.asked';

interface PrimeState {
  visibleMoment: PrimeMoment | null;
  show: (moment: PrimeMoment) => void;
  dismiss: () => void;
}

export const usePrimeStore = create<PrimeState>((set) => ({
  visibleMoment: null,
  show: (moment) => set({ visibleMoment: moment }),
  dismiss: () => set({ visibleMoment: null }),
}));

export function markPrimeAsked(): void {
  store.set(KEY_ASKED, true);
}

/** Call at an in-context moment. Shows the priming card at most once per
 *  install; silently no-ops if the question was ever answered. */
export function maybePrimeNotifications(moment: PrimeMoment): void {
  if (store.getBoolean(KEY_ASKED)) return;
  // A brief beat after the triggering success moment (haptic/toast settle).
  setTimeout(() => usePrimeStore.getState().show(moment), 600);
}

/** Test seam. */
export function resetPrimingForTests(): void {
  store.delete(KEY_ASKED);
  usePrimeStore.setState({ visibleMoment: null });
}
