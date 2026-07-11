import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User } from '@swift/types';
import { queryClient } from '../lib/queryClient';
import { zustandStorage } from '../lib/storage';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  // Guests browse freely; an action needing an account flips this to swap the
  // root navigator into the auth flow (and back to browsing on cancel).
  wantsAuth: boolean;
  // One-app routing: what the user picked on the entry "How will you use Swift?"
  // screen. 'customer' browses as a guest; 'mover'/'vendor' must sign in + onboard.
  intent: 'customer' | 'mover' | 'vendor' | null;
  countryCode: string | null;
  dialCode: string | null;
  currencyCode: string | null;
  currencySymbol: string | null;
  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  promptLogin: () => void;
  cancelAuth: () => void;
  setIntent: (intent: 'customer' | 'mover' | 'vendor' | null) => void;
  setCountry: (c: { code: string; dialCode?: string | null; currencyCode?: string | null; currencySymbol?: string | null }) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

// Persisted to MMKV so a cold start restores the session (token + active role +
// country) instead of re-prompting for country/login. The API + socket layers
// read accessToken/refreshToken via getState(), so a restored token is used
// immediately; a stale one is handled by the 401 -> refresh -> logout flow.
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: true,
      wantsAuth: false,
      intent: null,
      countryCode: null,
      dialCode: null,
      currencyCode: null,
      currencySymbol: null,
      setAuth: (user, accessToken, refreshToken) => {
        // The surface follows THIS account's roles — never inherit the previous
        // session's mode (a driver signing in after a vendor session must not
        // land in the vendor dashboard on a shared device). A multi-role
        // account keeps the prior choice only when it actually has that role.
        const u: any = user;
        const roles: string[] = u?.roles ?? [];
        const isMover = roles.includes('DRIVER') || roles.includes('RIDER') || roles.includes('MOVER') || !!u?.driver || !!u?.rider;
        const isVendor = roles.includes('VENDOR') || !!u?.vendorOwner;
        const prev = get().intent;
        const intent =
          (prev === 'vendor' && isVendor) || (prev === 'mover' && isMover) || prev === 'customer'
            ? prev
            : isVendor && !isMover
              ? ('vendor' as const)
              : isMover && !isVendor
                ? ('mover' as const)
                : ('customer' as const);
        set({ user, accessToken, refreshToken, isAuthenticated: true, isLoading: false, wantsAuth: false, intent });
      },
      setUser: (user) => set({ user }),
      promptLogin: () => set({ wantsAuth: true }),
      cancelAuth: () => set({ wantsAuth: false }),
      setIntent: (intent) => set({ intent }),
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
        // Deactivate this device's push token BEFORE the token-bearing session
        // dies (the DELETE needs auth); best-effort and config-gated inside.
        void import('../services/push').then((m) => m.unregisterDeviceForPush());
        set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false });
        queryClient.clear();
        // Lazy import: socket.ts reads this store, so a static import here
        // would be a require cycle (Metro warning + fragile init order).
        void import('../services/socket').then((m) => m.disconnectSocket());
      },
      setLoading: (isLoading) => set({ isLoading }),
    }),
    {
      name: 'swift-auth',
      storage: createJSONStorage(() => zustandStorage),
      version: 1,
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
        countryCode: state.countryCode,
        dialCode: state.dialCode,
        currencyCode: state.currencyCode,
        currencySymbol: state.currencySymbol,
      }),
    },
  ),
);
