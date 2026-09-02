import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as Crypto from 'expo-crypto';
import type { User } from '@swift/types';
import type { AdEventScope } from '../lib/adsCore';
import { retireAdEventScope } from '../lib/adsQueue';
import { queryClient } from '../lib/queryClient';
import { zustandStorage } from '../lib/storage';
import { landingIntent } from '../lib/roleLanding';
import { normalizePersistedAuth, recordHydration, type HydrationReason } from '../lib/authHydration';
import { track } from '../lib/analytics';
import { useBookingStore } from './bookingStore';
import { useStoreSwitcher } from './storeSwitcher';
import {
  sameAuthSession,
  samePrincipalBoundary,
  type AuthPrincipalBoundary,
  type AuthSessionSnapshot,
  type RotatedAuthTokens,
} from '../lib/authSession';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Durable monotonic principal boundary. Every login/logout invalidates work
   * captured by the previous account, including persisted async queues. */
  sessionGeneration: number;
  /** Random per-boundary owner persisted only inside encrypted auth storage.
   * Plain async queues store this opaque value, never a user ID or credential. */
  adEventScopeId: string;
  // Guests browse freely; an action needing an account flips this to swap the
  // root navigator into the auth flow (and back to browsing on cancel).
  wantsAuth: boolean;
  // One-app routing: what the user picked on the entry "How will you use Swift?"
  // screen. 'customer' browses as a guest; 'mover'/'vendor' must sign in + onboard.
  intent: 'customer' | 'mover' | 'vendor' | 'advertiser' | null;
  // When intent is 'mover', which kind they picked on the entry screen —
  // 'delivery' (rider) pre-selects a bike/moped in onboarding, 'taxi' a car.
  // Routing is identical (both are the mover app); this is only the default.
  moverPreset: 'delivery' | 'taxi' | null;
  countryCode: string | null;
  dialCode: string | null;
  currencyCode: string | null;
  currencySymbol: string | null;
  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  rotateTokensIfCurrent: (
    expected: AuthSessionSnapshot,
    tokens: RotatedAuthTokens,
  ) => AuthSessionSnapshot | null;
  logoutIfCurrent: (expected: AuthSessionSnapshot) => boolean;
  setUser: (user: User) => void;
  setUserIfCurrent: (expected: AuthPrincipalBoundary, user: User) => boolean;
  promptLogin: () => void;
  cancelAuth: () => void;
  setIntent: (intent: 'customer' | 'mover' | 'vendor' | 'advertiser' | null) => void;
  setIntentIfCurrent: (
    expected: AuthPrincipalBoundary,
    intent: 'customer' | 'mover' | 'vendor' | 'advertiser' | null,
  ) => boolean;
  setMoverPreset: (preset: 'delivery' | 'taxi' | null) => void;
  setCountry: (c: { code: string; dialCode?: string | null; currencyCode?: string | null; currencySymbol?: string | null }) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

function snapshotFor(state: Pick<
  AuthState,
  'sessionGeneration' | 'adEventScopeId' | 'user' | 'accessToken' | 'refreshToken' | 'isAuthenticated'
>): AuthSessionSnapshot | null {
  if (!state.isAuthenticated || !state.user?.id || !state.accessToken || !state.refreshToken) return null;
  return {
    generation: state.sessionGeneration,
    userId: state.user.id,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    adEventScopeId: state.adEventScopeId,
  };
}

function createAdEventScopeId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    // This is an ownership nonce, not a bearer credential. The fallback keeps
    // stale native binaries safe while retaining effectively unique scopes.
    return `ad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Every path that ends the current session must return the one-app shell to
 * its experience picker. Country and market settings are device context, not
 * session context, so they deliberately remain untouched. */
function nextLoggedOutState(state: Pick<AuthState, 'sessionGeneration'>) {
  return {
    user: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    wantsAuth: false,
    intent: null,
    moverPreset: null,
    sessionGeneration: state.sessionGeneration + 1,
    adEventScopeId: createAdEventScopeId(),
  };
}

async function revokeCapturedSession(session: AuthSessionSnapshot): Promise<void> {
  let pushToken: string | null = null;
  try {
    const push = await import('../services/push');
    pushToken = await push.preparePushTokenForLogout(session);
  } catch {
    // Server logout still matters if the native notification provider fails.
  }

  try {
    const auth = await import('../services/api');
    await auth.revokeAuthSession(session.refreshToken, pushToken);
  } catch {
    // Local logout is immediate and deterministic. Remote teardown is
    // best-effort because the device can be offline; the short-lived access
    // token still expires and refresh rotation/replay defenses remain active.
  }
}

function finishLocalLogout(session: AuthSessionSnapshot | null): void {
  if (session?.adEventScopeId) {
    // Synchronous and exact-owner: A is retired before B can become usable,
    // while a stale A cleanup can never delete a newer boundary's events.
    retireAdEventScope({
      kind: 'AUTHENTICATED',
      scopeId: session.adEventScopeId,
      generation: session.generation,
    });
  }
  queryClient.clear();
  // Appointment selections are session-scoped. Clear them synchronously so a
  // shared-device login can never submit the previous account's chosen slot.
  useBookingStore.getState().clear();
  // Vendor tenant selection is process-global, not part of the query cache.
  // A shared-device login must never inherit another account's store header.
  useStoreSwitcher.getState().setSelectedStore(null);
  if (!session) return;
  // Lazy imports can resolve after another account has already signed in and
  // claimed these process-global native resources. Pass the captured owner so
  // A's teardown becomes a no-op once B owns the socket or GPS runtime.
  void import('../services/backgroundLocation').then((m) => m.stopMoverLocation(session));
  void import('../services/socket').then((m) => m.disconnectSocket(session));
  void revokeCapturedSession(session);
}

// Persisted to MMKV so a cold start restores the session (token + active role +
// country) instead of re-prompting for country/login. The API + socket layers
// read accessToken/refreshToken via getState(), so a restored token is used
// immediately; a stale one is handled by the 401 -> refresh -> logout flow.
/** What the last hydration decided — read by onRehydrateStorage to persist a normalization. */
let lastHydration: { reason: HydrationReason; normalized: boolean } | null = null;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: true,
      sessionGeneration: 0,
      adEventScopeId: createAdEventScopeId(),
      wantsAuth: false,
      intent: null,
      moverPreset: null,
      countryCode: null,
      dialCode: null,
      currencyCode: null,
      currencySymbol: null,
      setAuth: (user, accessToken, refreshToken) => {
        const previousSession = snapshotFor(get());
        // The account answers [first-open SO-4]: a living valid choice
        // survives; otherwise the server's last-used activeRole routes — a
        // reinstalled multi-role account lands where it last worked, and a
        // driver signing in after a vendor session on a shared device never
        // lands in the vendor dashboard. Pure law + tests: lib/roleLanding.
        const u: any = user;
        const roles: string[] = u?.roles ?? [];
        const isMover = roles.includes('DRIVER') || roles.includes('RIDER') || roles.includes('MOVER') || !!u?.driver || !!u?.rider;
        const isVendor = roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!u?.vendorOwner;
        const intent = landingIntent(get().intent, {
          isVendor,
          isMover,
          activeRole: typeof u?.activeRole === 'string' ? u.activeRole : null,
        });
        // This is an interactive authentication boundary, never a token
        // refresh. In-flight work from the previous principal becomes stale.
        // Also cover an interactive re-auth that replaces an existing session
        // without first rendering the logged-out tree. Cache/native/runtime
        // teardown receives the captured old owner and cannot disturb the new
        // account installed immediately below.
        if (previousSession) finishLocalLogout(previousSession);
        else useStoreSwitcher.getState().setSelectedStore(null);
        set((state) => ({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
          isLoading: false,
          wantsAuth: false,
          intent,
          sessionGeneration: state.sessionGeneration + 1,
          adEventScopeId: createAdEventScopeId(),
        }));
      },
      rotateTokensIfCurrent: (expected, tokens) => {
        let rotated: AuthSessionSnapshot | null = null;
        set((state) => {
          if (!sameAuthSession(snapshotFor(state), expected)) return {};
          rotated = { ...expected, ...tokens };
          return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
        });
        return rotated;
      },
      logoutIfCurrent: (expected) => {
        let didLogout = false;
        set((state) => {
          if (!sameAuthSession(snapshotFor(state), expected)) return {};
          didLogout = true;
          return nextLoggedOutState(state);
        });
        if (didLogout) finishLocalLogout(expected);
        return didLogout;
      },
      setUser: (user) => set({ user }),
      setUserIfCurrent: (expected, user) => {
        let didSet = false;
        set((state) => {
          if (
            user.id !== expected.userId
            || !samePrincipalBoundary(snapshotFor(state), expected)
          ) return {};
          didSet = true;
          return { user };
        });
        return didSet;
      },
      promptLogin: () => set({ wantsAuth: true }),
      cancelAuth: () => set({ wantsAuth: false }),
      setIntent: (intent) => set({ intent }),
      setIntentIfCurrent: (expected, intent) => {
        let didSet = false;
        set((state) => {
          if (!samePrincipalBoundary(snapshotFor(state), expected)) return {};
          didSet = true;
          return { intent };
        });
        return didSet;
      },
      setMoverPreset: (moverPreset) => set({ moverPreset }),
      setCountry: (c) =>
        set({
          countryCode: c.code,
          dialCode: c.dialCode ?? null,
          currencyCode: c.currencyCode ?? null,
          currencySymbol: c.currencySymbol ?? null,
        }),
      // Keep countryCode through logout so we don't re-prompt for country on sign-out.
      // Everything session-scoped goes with the session: the query cache (a shared
      // device must not show the next user this user's orders/addresses) and the
      // socket (authed with the old token; the next session reconnects fresh).
      logout: () => {
        const session = snapshotFor(get());
        // Clear synchronously so the UI, query cache, sockets, GPS supervisor,
        // and every in-flight request see the logout before another account can
        // enter. Remote cleanup receives the captured credentials explicitly.
        set((state) => nextLoggedOutState(state));
        finishLocalLogout(session);
      },
      setLoading: (isLoading) => set({ isLoading }),
    }),
    {
      name: 'swift-auth',
      storage: createJSONStorage(() => zustandStorage),
      version: 2,
      // [MOB-007] `migrate` runs only on a version change, so it cannot be the
      // gate: it tags the raw tuple with its version and `merge` — which runs
      // on EVERY hydration — normalizes. One law for v1, v2 and whatever else
      // storage returns: a full consistent tuple, or signed out.
      migrate: (persistedState, persistedVersion) => ({ __version: persistedVersion, __state: persistedState }) as never,
      merge: (persisted, current) => {
        if (persisted === undefined || persisted === null) return current; // nothing stored: a fresh install
        const tagged = persisted as { __version?: number; __state?: unknown };
        const [raw, version] = typeof tagged === 'object' && '__version' in tagged ? [tagged.__state, tagged.__version ?? 0] : [persisted, 2];
        const { state, reason, normalized } = normalizePersistedAuth(raw, version, createAdEventScopeId);
        recordHydration(reason);
        lastHydration = { reason, normalized };
        if (normalized) {
          // An inconsistent tuple never reaches a privileged render: signed out
          // atomically, and everything session-scoped goes with it. The
          // principal generation has advanced, so persisted background work
          // keyed to the old boundary is stale (moverBackgroundRuntime treats a
          // signed-out rehydration as cleanup-pending).
          queryClient.clear();
          useBookingStore.getState().clear();
          useStoreSwitcher.getState().setSelectedStore(null);
          track('auth_hydration_normalized', { reason });
        }
        return { ...current, ...state } as AuthState;
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          // Unreadable storage hydrates nothing: the initial (signed-out) state stands.
          recordHydration('unreadable');
          track('auth_hydration_normalized', { reason: 'unreadable' });
          return;
        }
        // Write the normalized tuple back so the next boot reads a consistent one.
        if (lastHydration?.normalized) useAuthStore.setState({});
      },
      // The encryption key is read from the Keychain asynchronously, so MMKV
      // isn't ready at module load. App boots the key then calls
      // useAuthStore.persist.rehydrate() before the first render.
      skipHydration: true,
      // Only durable identity is persisted; isLoading is transient UI state.
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        intent: state.intent,
        moverPreset: state.moverPreset,
        countryCode: state.countryCode,
        dialCode: state.dialCode,
        currencyCode: state.currencyCode,
        currencySymbol: state.currencySymbol,
        sessionGeneration: state.sessionGeneration,
        adEventScopeId: state.adEventScopeId,
      }),
    },
  ),
);

export function getAuthSessionSnapshot(): AuthSessionSnapshot | null {
  return snapshotFor(useAuthStore.getState());
}

/** Capture the exact local attribution boundary for an ad serve. The opaque
 * scope ID is safe to persist in the plain ad queue; user IDs and tokens are
 * deliberately excluded. */
export function getAdEventTrackingScope(): AdEventScope {
  const state = useAuthStore.getState();
  return {
    kind: snapshotFor(state) ? 'AUTHENTICATED' : 'ANONYMOUS',
    scopeId: state.adEventScopeId,
    generation: state.sessionGeneration,
  };
}

export class AuthSessionBoundaryError extends Error {
  constructor() {
    super('The authenticated account changed while this operation was running');
    this.name = 'AuthSessionBoundaryError';
  }
}

/** Capture the principal that authorizes a multi-step operation. */
export function requireAuthSessionSnapshot(): AuthSessionSnapshot {
  const session = getAuthSessionSnapshot();
  if (!session) throw new AuthSessionBoundaryError();
  return session;
}

/** Continue a captured operation only inside its original login boundary.
 * Token rotation is safe: callers receive the principal's newest credentials.
 * Logout or a subsequent login throws before another API call/state write. */
export function requireAuthSessionForPrincipal(
  expected: AuthPrincipalBoundary,
): AuthSessionSnapshot {
  const current = getAuthSessionSnapshot();
  if (!samePrincipalBoundary(current, expected)) {
    throw new AuthSessionBoundaryError();
  }
  return current!;
}

export function isAuthSessionSnapshotCurrent(expected: AuthSessionSnapshot): boolean {
  return sameAuthSession(getAuthSessionSnapshot(), expected);
}
