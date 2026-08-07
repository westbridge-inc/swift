import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandStorage } from '../lib/storage';
import type { LocationStatus } from '../lib/deviceLocation';

export type { LocationStatus } from '../lib/deviceLocation';

// Resolution status drives the UI: while 'unknown'/'resolving' we can still show
// a last-known (persisted) location; 'denied'/'unavailable' is what an actionable
// fallback card keys off of — never a dead "Location unavailable" string.
interface LocationState {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  status: LocationStatus;
  setLocation: (lat: number, lng: number, address?: string) => void;
  setStatus: (status: LocationStatus) => void;
}

// Persisted to MMKV so a cold start renders a map at the last-known location
// immediately (no white void) while useDeviceLocation silently refreshes an
// existing grant. Coordinates and their OS-derived label are durable only as
// last-known context; `status` is recomputed each launch without opening an OS
// permission dialog.
export const useLocationStore = create<LocationState>()(
  persist(
    (set) => ({
      latitude: null,
      longitude: null,
      address: null,
      status: 'unknown',
      setLocation: (latitude, longitude, address) =>
        set({ latitude, longitude, address, status: 'granted' }),
      setStatus: (status) => set({ status }),
    }),
    {
      name: 'swift-location',
      storage: createJSONStorage(() => zustandStorage),
      version: 1,
      // MMKV's key is read from the Keychain asynchronously (see lib/storage),
      // so App boots the key then calls rehydrate() before the first render.
      skipHydration: true,
      partialize: (state) => ({
        latitude: state.latitude,
        longitude: state.longitude,
        address: state.address,
      }),
    },
  ),
);
