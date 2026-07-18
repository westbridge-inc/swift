import { describe, it, expect } from 'vitest';
import { assertSafeBootConfig } from '../utils/boot-config';

// SWIFT-AUD-D9-02 / D3-01: production must refuse to boot without the two
// secrets that keep KYC documents private (envelope KEK + render HMAC), and
// without the OTP-bypass guard. Non-production is unaffected.

const KEK = Buffer.alloc(32, 7).toString('base64'); // valid 32-byte base64
const good: Record<string, string | undefined> = { NODE_ENV: 'production', MASTER_KEK: KEK, STORAGE_SIGNING_SECRET: 'a-real-secret' };

describe('assertSafeBootConfig — fail-closed production secrets', () => {
  it('boots when every required secret is present', () => {
    expect(() => assertSafeBootConfig(good)).not.toThrow();
  });

  it('refuses to boot in production without MASTER_KEK (KYC would store plaintext)', () => {
    expect(() => assertSafeBootConfig({ ...good, MASTER_KEK: undefined })).toThrow(/MASTER_KEK/);
  });

  it('refuses a malformed (non-32-byte) MASTER_KEK', () => {
    expect(() => assertSafeBootConfig({ ...good, MASTER_KEK: 'too-short' })).toThrow(/32 bytes/);
  });

  it('refuses to boot in production without STORAGE_SIGNING_SECRET (render token forgeable)', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_SIGNING_SECRET: undefined })).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('refuses the published default STORAGE_SIGNING_SECRET in production', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_SIGNING_SECRET: 'dev-signing-secret' })).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('still refuses DEV_OTP_BYPASS=1 in production', () => {
    expect(() => assertSafeBootConfig({ ...good, DEV_OTP_BYPASS: '1' })).toThrow(/DEV_OTP_BYPASS/);
  });

  it('does NOT enforce any of this outside production (dev/test boot freely)', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', DEV_OTP_BYPASS: '1' })).not.toThrow();
  });
});
