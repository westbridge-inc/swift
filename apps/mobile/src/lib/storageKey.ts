const MMKV_KEY_BYTES = 16;
const NEW_KEY_RANDOM_BYTES = 12;
const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * MMKV 3 uses an AES-128 key and consumes at most the first 16 bytes. Older
 * Swift builds stored 32 random bytes as 64 hexadecimal characters; native MMKV
 * silently used the first 16 ASCII characters. Keep that exact effective key so
 * an upgrade can still decrypt the existing store.
 */
export function effectiveMmkvEncryptionKey(storedKey: string): string {
  if (!storedKey || !/^[\x20-\x7E]+$/.test(storedKey)) {
    throw new Error('The secure-storage key is not a supported printable value');
  }
  return storedKey.slice(0, MMKV_KEY_BYTES);
}

/** Encode 96 CSPRNG bits as exactly 16 printable ASCII/base64url characters.
 * Every input bit is preserved and the result fits MMKV's 16-byte limit. */
export function createPrintableMmkvEncryptionKey(randomBytes: Uint8Array): string {
  if (randomBytes.length < NEW_KEY_RANDOM_BYTES) {
    throw new Error(`Secure-storage key generation requires ${NEW_KEY_RANDOM_BYTES} random bytes`);
  }

  let output = '';
  for (let offset = 0; offset < NEW_KEY_RANDOM_BYTES; offset += 3) {
    const chunk = (randomBytes[offset]! << 16)
      | (randomBytes[offset + 1]! << 8)
      | randomBytes[offset + 2]!;
    output += BASE64_URL_ALPHABET[(chunk >>> 18) & 63];
    output += BASE64_URL_ALPHABET[(chunk >>> 12) & 63];
    output += BASE64_URL_ALPHABET[(chunk >>> 6) & 63];
    output += BASE64_URL_ALPHABET[chunk & 63];
  }
  return output;
}

export const MMKV_NEW_KEY_RANDOM_BYTES = NEW_KEY_RANDOM_BYTES;
