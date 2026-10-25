import type { RootEntryGate, RootIntent } from './rootEntryGate';

export interface MenuItemAddDraft {
  quantity: number;
  selectedOptions: Record<string, string | string[]>;
  dayOffset: number;
  slot: string | null;
  visitMode: 'AT_BUSINESS' | 'MOBILE';
  /** [row 70] The item note typed before signing in; omitted when empty. */
  notes?: string;
}

export type AuthContinuationDestination = {
  /** Destinations resume only after the root authentication gates complete. */
  screen: 'ServiceProvider' | 'Taxi';
} | { screen: 'Restaurant'; vendorId: string }
  | { screen: 'MenuItem'; vendorId: string; itemId: string; addDraft: MenuItemAddDraft };

export interface AuthContinuationRootRoute {
  screen: 'Main' | 'Storefront';
  params: { screen: AuthContinuationDestination['screen']; params?: { vendorId: string } } | {
    state: { stale: true; index: number; routes: Array<{ name: string; params: Record<string, unknown> }> };
  };
}

export type AuthContinuationFlushResult =
  | 'none'
  | 'waiting'
  | 'delivered'
  | 'retry'
  | 'discarded';

let pending: AuthContinuationDestination | null = null;

/** Queue before opening auth so a synchronous root swap cannot lose the
 * destination. The continuation is process-local and one-shot: a cold restart
 * opens the ordinary safe landing instead of replaying stale UI intent. */
export function requestAuthContinuation(
  destination: AuthContinuationDestination,
  promptLogin: () => void,
): void {
  pending = destination;
  promptLogin();
}

export function discardAuthContinuation(): void {
  pending = null;
}

export function rootRouteForAuthContinuation(
  destination: AuthContinuationDestination,
): AuthContinuationRootRoute {
  if (destination.screen === 'MenuItem') {
    const { vendorId, itemId, addDraft } = destination;
    return { screen: 'Storefront', params: { state: { stale: true, index: 1, routes: [
      { name: 'Restaurant', params: { vendorId } },
      { name: 'MenuItem', params: { vendorId, itemId, addDraft, addAfterSignIn: true } },
    ] } } };
  }
  if (destination.screen === 'Restaurant') {
    return { screen: 'Storefront', params: { screen: 'Restaurant', params: { vendorId: destination.vendorId } } };
  }
  return { screen: 'Main', params: { screen: destination.screen } };
}

/** Resume only after every root gate (OTP, registration, mandatory selfie)
 * has completed and the customer navigator actually owns the destination. */
export function flushAuthContinuation(
  state: {
    isAuthenticated: boolean;
    entryGate: RootEntryGate;
    intent: RootIntent | null;
  },
  deliver: (destination: AuthContinuationDestination) => boolean,
): AuthContinuationFlushResult {
  if (!pending) return 'none';
  if (!state.isAuthenticated || state.entryGate !== 'main') return 'waiting';

  // Taxi/provider onboarding belong to the selected customer experience.
  // A scanned menu has its own public root and preserves any selected role.
  if (pending.screen !== 'Restaurant' && pending.screen !== 'MenuItem' && state.intent !== 'customer') {
    pending = null;
    return 'discarded';
  }

  const destination = pending;
  if (!deliver(destination)) return 'retry';
  pending = null;
  return 'delivered';
}
