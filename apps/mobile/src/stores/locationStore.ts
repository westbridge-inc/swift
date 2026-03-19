import { create } from 'zustand';

interface LocationState {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  setLocation: (lat: number, lng: number, address?: string) => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  latitude: null,
  longitude: null,
  address: null,
  setLocation: (latitude, longitude, address) => set({ latitude, longitude, address }),
}));
