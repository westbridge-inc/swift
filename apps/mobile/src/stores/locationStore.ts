import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandStorage } from '../lib/storage';
import {
  liveLocationState,
  resolvedLocationState,
  type LocationStatus,
} from '../lib/deviceLocation';

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
  setLiveLocation: (lat: number, lng: number) => void;
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
        // A failed reverse geocode clears the old coordinate's label; otherwise
        // a new GPS fix can falsely retain the previous street.
        set(resolvedLocationState(latitude, longitude, address)),
      // Continuous mover samples intentionally avoid reverse-geocoding every
      // update. Clear the old label so it cannot describe the new coordinate.
      setLiveLocation: (latitude, longitude) =>
        set(liveLocationState(latitude, longitude)),
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
