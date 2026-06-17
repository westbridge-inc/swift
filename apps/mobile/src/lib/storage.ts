import { MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

// Single shared MMKV instance for the app. MMKV is synchronous, so any zustand
// store persisted through `zustandStorage` rehydrates during store creation —
// the first render already sees persisted state (no cold-start flash / re-login).
export const storage = new MMKV();

export const zustandStorage: StateStorage = {
  getItem: (name) => storage.getString(name) ?? null,
  setItem: (name, value) => storage.set(name, value),
  removeItem: (name) => storage.delete(name),
};
