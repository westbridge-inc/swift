import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvKeyProvider, decryptBuffer, encryptBuffer, generateDek } from '../providers/storage/envelope';

describe('MASTER-080 envelope helper boundaries', () => {
  it('rejects string keys instead of accepting character counts as byte lengths', async () => {
    const key = 'k'.repeat(32) as unknown as Buffer;
    expect(() => encryptBuffer(Buffer.from('fixture'), key)).toThrow();
    await expect(new EnvKeyProvider(generateDek().toString('base64')).wrapDek(key)).rejects.toThrow();
  });
  it('rejects a twelve-character UTF-8 IV carrying twenty-four bytes', () => {
    const key = generateDek();
    const iv = 'é'.repeat(12);
    expect(Buffer.byteLength(iv)).toBe(24);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('synthetic document'), cipher.final()]);
    expect(() => decryptBuffer(ciphertext, key, iv as unknown as Buffer, cipher.getAuthTag())).toThrow();
  });
  it.each([0, 4, 8, 12, 13, 14, 15, 17])('rejects a %i-byte authentication tag', (length) => {
    const key = generateDek();
    const value = encryptBuffer(Buffer.from('synthetic document'), key);
    const tag = Buffer.alloc(length);
    value.authTag.copy(tag);
    expect(() => decryptBuffer(value.ciphertext, key, value.iv, tag)).toThrow();
  });
  it.each([0, 1, 11, 13, 16])('rejects a %i-byte IV even with a matching valid GCM tag', (length) => {
    const key = generateDek();
    if (length === 0) {
      expect(() => decryptBuffer(Buffer.alloc(0), key, Buffer.alloc(0), Buffer.alloc(16))).toThrow();
      return;
    }
    const iv = crypto.randomBytes(length);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('synthetic document'), cipher.final()]);
    expect(() => decryptBuffer(ciphertext, key, iv, cipher.getAuthTag())).toThrow();
  });
  it.each([0, 16, 24, 31, 33])('rejects a %i-byte DEK at every entry point', async (length) => {
    const key = Buffer.alloc(length);
    const provider = new EnvKeyProvider(generateDek().toString('base64'));
    expect(() => encryptBuffer(Buffer.from('fixture'), key)).toThrow();
    expect(() => decryptBuffer(Buffer.alloc(0), key, Buffer.alloc(12), Buffer.alloc(16))).toThrow();
    await expect(provider.wrapDek(key)).rejects.toThrow();
  });
  it.each([0, 1, 16, 31, 33, 64])('rejects an authentic wrapping blob carrying %i bytes rather than one DEK', async (length) => {
    const kek = generateDek();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
    const ct = Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]);
    const wrapped = Buffer.concat([iv, cipher.getAuthTag(), ct]);
    await expect(new EnvKeyProvider(kek.toString('base64')).unwrapDek(wrapped)).rejects.toThrow();
  });
  it('round-trips empty and nonempty documents and refuses modified ciphertext', async () => {
    const provider = new EnvKeyProvider(generateDek().toString('base64'));
    const key = generateDek();
    expect(await provider.unwrapDek(await provider.wrapDek(key))).toEqual(key);
    for (const plaintext of [Buffer.alloc(0), Buffer.from('synthetic document')]) {
      const value = encryptBuffer(plaintext, key);
      expect(decryptBuffer(value.ciphertext, key, value.iv, value.authTag)).toEqual(plaintext);
      const bad = Buffer.concat([value.ciphertext, Buffer.from([1])]);
      expect(() => decryptBuffer(bad, key, value.iv, value.authTag)).toThrow();
    }
  });
});
