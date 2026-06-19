import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { StateStorage } from 'zustand/middleware';

// MASVS: the persisted session (auth token) must be encrypted at rest. We open
// MMKV with a 256-bit AES key that lives in the iOS Keychain / Android Keystore
// (via expo-secure-store) — never in plaintext on disk. MMKV is synchronous but
// the Keychain read is async, so the key is bootstrapped once at startup
// (initSecureStorage) before the auth store rehydrates; App gates the first
// render on it, preserving zustand's instant (no-flash) rehydration.

const KEY_ALIAS = 'swift.mmkv.encryptionKey';

let storage: MMKV | null = null;

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Read (or first-time generate) the device-bound encryption key, then open the
 *  encrypted store. Idempotent — safe to await more than once. */
export async function initSecureStorage(): Promise<void> {
  if (storage) return;
  let key = await SecureStore.getItemAsync(KEY_ALIAS);
  if (!key) {
    // 256-bit key from the platform CSPRNG, stored device-only (not synced to
    // iCloud Keychain or device backups), available after first unlock.
    key = toHex(Crypto.getRandomBytes(32));
    await SecureStore.setItemAsync(KEY_ALIAS, key, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }
  storage = new MMKV({ id: 'swift-secure', encryptionKey: key });
}

function requireStorage(): MMKV {
  if (!storage) {
    throw new Error('Secure storage not initialised — call initSecureStorage() before use');
  }
  return storage;
}

export const zustandStorage: StateStorage = {
  getItem: (name) => requireStorage().getString(name) ?? null,
  setItem: (name, value) => requireStorage().set(name, value),
  removeItem: (name) => requireStorage().delete(name),
};
