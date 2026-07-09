import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandStorage } from '../lib/storage';

interface AppState {
  // First-run gate: the 3-slide onboarding shows once, then never again.
  hasOnboarded: boolean;
  setOnboarded: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      hasOnboarded: false,
      setOnboarded: () => set({ hasOnboarded: true }),
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
