import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandStorage } from '../lib/storage';

interface AppState {
  // First-run gate: the 3-slide onboarding shows once, then never again.
  hasOnboarded: boolean;
  setOnboarded: () => void;
  // Device-local search history (kit "Your search history" chips).
  recentSearches: string[];
  pushSearch: (q: string) => void;
  clearSearches: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      hasOnboarded: false,
      setOnboarded: () => set({ hasOnboarded: true }),
      recentSearches: [],
      pushSearch: (q) =>
        set((s) => {
          const clean = q.trim();
          if (clean.length < 2) return s;
          return { recentSearches: [clean, ...s.recentSearches.filter((r) => r.toLowerCase() !== clean.toLowerCase())].slice(0, 8) };
        }),
      clearSearches: () => set({ recentSearches: [] }),
    }),
    {
      name: 'swift-app',
      storage: createJSONStorage(() => zustandStorage),
      version: 1,
      // Same encrypted-MMKV bootstrap as authStore: App awaits initSecureStorage()
      // then rehydrates explicitly before first render.
      skipHydration: true,
    },
  ),
);
