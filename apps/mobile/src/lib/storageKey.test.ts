import { describe, expect, it } from 'vitest';
import {
  createPrintableMmkvEncryptionKey,
  effectiveMmkvEncryptionKey,
  MMKV_NEW_KEY_RANDOM_BYTES,
} from './storageKey';

describe('secure MMKV key compatibility', () => {
  it('preserves the historical effective key used by 64-character hex installs', () => {
    const historical = '0123456789abcdef'.repeat(4);
    expect(effectiveMmkvEncryptionKey(historical)).toBe('0123456789abcdef');
  });

  it('leaves an already-valid printable key unchanged', () => {
    expect(effectiveMmkvEncryptionKey('SwiftKey_1234-AB')).toBe('SwiftKey_1234-AB');
  });

  it('rejects empty and non-printable stored keys instead of rotating data away', () => {
    expect(() => effectiveMmkvEncryptionKey('')).toThrow(/not a supported printable value/);
    expect(() => effectiveMmkvEncryptionKey('valid\u0000invalid')).toThrow(/not a supported printable value/);
  });

  it('encodes 96 random bits as a valid 16-byte printable base64url key', () => {
    const random = Uint8Array.from({ length: MMKV_NEW_KEY_RANDOM_BYTES }, (_, index) => index);
    const key = createPrintableMmkvEncryptionKey(random);

    expect(key).toBe('AAECAwQFBgcICQoL');
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('refuses an undersized random source', () => {
    expect(() => createPrintableMmkvEncryptionKey(new Uint8Array(11))).toThrow(/requires 12 random bytes/);
  });
});
