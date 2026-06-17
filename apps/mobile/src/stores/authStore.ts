import { create } from 'zustand';
import type { User } from '@swift/types';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  countryCode: string | null;
  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  setCountry: (countryCode: string) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  isAuthenticated: false,
  isLoading: true,
  countryCode: null,
  setAuth: (user, accessToken, refreshToken) =>
    set({ user, accessToken, refreshToken, isAuthenticated: true, isLoading: false }),
  setUser: (user) => set({ user }),
  setCountry: (countryCode) => set({ countryCode }),
  // Keep countryCode through logout so we don't re-prompt for country on sign-out.
  logout: () => set({ user: null, accessToken: null, refreshToken: null, isAuthenticated: false }),
  setLoading: (isLoading) => set({ isLoading }),
}));
