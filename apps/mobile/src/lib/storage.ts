import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import type { StateStorage } from 'zustand/middleware';
import {
  createPrintableMmkvEncryptionKey,
  effectiveMmkvEncryptionKey,
  MMKV_NEW_KEY_RANDOM_BYTES,
} from './storageKey';

// MASVS: the persisted session (auth token) must be encrypted at rest. MMKV 3
// uses AES-128 and accepts at most 16 key bytes; the printable device key lives
// in the iOS Keychain / Android Keystore (via expo-secure-store), never alongside
// the database. MMKV is synchronous but the Keychain read is async, so startup
// opens it before persisted stores rehydrate and App renders.

const KEY_ALIAS = 'swift.mmkv.encryptionKey';

let storage: MMKV | null = null;
let storageInit: Promise<void> | null = null;

/** Read (or first-time generate) the device-bound encryption key, then open the
 *  encrypted store. Idempotent — safe to await more than once. */
export async function initSecureStorage(): Promise<void> {
  if (storage) return;
  storageInit ??= (async () => {
    let storedKey = await SecureStore.getItemAsync(KEY_ALIAS);
    if (!storedKey) {
      // MMKV accepts at most 16 bytes. Twelve CSPRNG bytes encode to exactly 16
      // printable base64url characters (96 bits) with no truncation or bias.
      storedKey = createPrintableMmkvEncryptionKey(
        Crypto.getRandomBytes(MMKV_NEW_KEY_RANDOM_BYTES),
      );
      await SecureStore.setItemAsync(KEY_ALIAS, storedKey, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    }
    // Do not rewrite an old 64-hex Keychain value. Previous native MMKV builds
    // already encrypted with its first 16 ASCII bytes; using the same effective
    // key is the lossless migration path for existing installs.
    const encryptionKey = effectiveMmkvEncryptionKey(storedKey);
    storage = new MMKV({ id: 'swift-secure', encryptionKey });
  })().catch((error) => {
    // A locked Keychain can reject a headless/background attempt before first
    // unlock. Permit the visible app to retry later instead of caching failure.
    storageInit = null;
    throw error;
  });
  await storageInit;
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
