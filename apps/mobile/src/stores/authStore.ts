import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User } from '@swift/types';
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
    (set) => ({
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
      setAuth: (user, accessToken, refreshToken) =>
        set({ user, accessToken, refreshToken, isAuthenticated: true, isLoading: false, wantsAuth: false }),
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
      logout: () => set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false }),
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
