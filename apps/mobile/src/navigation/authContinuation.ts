import type { RootEntryGate, RootIntent } from './rootEntryGate';

export interface AuthContinuationDestination {
  /** The destination is intentionally constrained to screens that are safe to
   * resume inside the authenticated customer stack. */
  screen: 'ServiceProvider';
}

export interface AuthContinuationRootRoute {
  screen: 'Main';
  params: { screen: AuthContinuationDestination['screen'] };
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

  // ServiceProvider belongs to CustomerStack. A role-routing regression must
  // never send it into an unrelated earner or advertiser navigator.
  if (state.intent !== 'customer') {
    pending = null;
    return 'discarded';
  }

  const destination = pending;
  if (!deliver(destination)) return 'retry';
  pending = null;
  return 'delivered';
}
