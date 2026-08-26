import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertSafeBootConfig, assertProductionData } from '../utils/boot-config';

// SWIFT-AUD-D9-02 / D3-01: production must refuse to boot without the two
// secrets that keep KYC documents private (envelope KEK + render HMAC), and
// without the OTP-bypass guard. Non-production is unaffected.

const KEK = Buffer.alloc(32, 7).toString('base64'); // valid 32-byte base64
const good: Record<string, string | undefined> = {
  NODE_ENV: 'production',
  MASTER_KEK: KEK,
  STORAGE_SIGNING_SECRET: 'a-real-secret',
  STORAGE_PROVIDER: 's3',
  NOTIFICATION_PROVIDER: 'twilio',
  PUSH_PROVIDER: 'expo',
  JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
  KYC_PROVIDER: 'didit',
  DIDIT_API_KEY: 'didit-live-key',
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_live_boot_config_test',
  MMG_DRIVER: 'live',
  MMG_API_URL: 'https://api.mmg.gy/olive/publisher/v1',
  MMG_API_KEY: 'mmg-api-key',
  MMG_MERCHANT_ID: '5926000000',
  MMG_PASSWORD: 'mmg-password',
  MMG_MKEY: 'mmg-mkey',
  MMG_MSECRET: 'mmg-msecret',
};

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

  it('requires a strong keyed-HMAC secret for OTP records', () => {
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: undefined })).toThrow(/OTP_HASH_SECRET|JWT_SECRET/);
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: 'too-short' })).toThrow(/32 characters/);
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: undefined, OTP_HASH_SECRET: 'dedicated-otp-secret-at-least-32-chars' })).not.toThrow();
  });

  it('refuses sandbox or unconfigured KYC in production', () => {
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: undefined })).toThrow(/KYC_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: 'sandbox' })).toThrow(/KYC_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, DIDIT_API_KEY: undefined })).toThrow(/DIDIT_API_KEY/);
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: 'idanalyzer', ID_ANALYZER_API_KEY: undefined })).toThrow(/ID_ANALYZER_API_KEY/);
  });

  it('refuses sandbox/test subscription card processors in production', () => {
    expect(() => assertSafeBootConfig({ ...good, PAYMENT_PROVIDER: undefined })).toThrow(/PAYMENT_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PAYMENT_PROVIDER: 'sandbox' })).toThrow(/PAYMENT_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, STRIPE_SECRET_KEY: 'sk_test_not_money' })).toThrow(/live STRIPE_SECRET_KEY/);
    expect(() => assertSafeBootConfig({
      ...good,
      PAYMENT_PROVIDER: 'powertranz',
      PAYMENT_GATEWAY_KEY: 'id',
      PAYMENT_GATEWAY_SECRET: 'secret',
      POWERTRANZ_API_URL: 'https://staging.ptranz.com',
    })).toThrow(/non-staging/);
  });

  it('refuses sandbox, UAT, or incomplete MMG collection in production', () => {
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: undefined })).toThrow(/MMG_DRIVER/);
    expect(() => assertSafeBootConfig({ ...good, MMG_DRIVER: 'sandbox' })).toThrow(/MMG_DRIVER/);
    expect(() => assertSafeBootConfig({ ...good, MMG_MSECRET: undefined })).toThrow(/MMG_MSECRET/);
    expect(() => assertSafeBootConfig({ ...good, MMG_API_URL: 'https://mwallet.mmgtest.net/olive/publisher/v1' })).toThrow(/non-UAT/);
  });

  it('SWIFT-012: refuses the dev (console) notification provider in production — OTP would never send', () => {
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: 'dev' })).toThrow(/NOTIFICATION_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: undefined })).toThrow(/NOTIFICATION_PROVIDER/);
  });

  it('SWIFT-012: accepts a real notification provider (twilio)', () => {
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: 'twilio' })).not.toThrow();
  });

  it('[NOC-A F1] refuses to boot production on the in-memory push provider', () => {
    // The same trap as NOTIFICATION_PROVIDER, one door over: PUSH_PROVIDER
    // also defaults to 'dev', whose provider appends to an array and reports
    // success — so production would swallow every order alert, dispatch offer
    // and safety ping while looking healthy.
    expect(() => assertSafeBootConfig({ ...good, PUSH_PROVIDER: 'dev' })).toThrow(/PUSH_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PUSH_PROVIDER: undefined })).toThrow(/PUSH_PROVIDER/);
    expect(() => assertSafeBootConfig({ ...good, PUSH_PROVIDER: 'expo' })).not.toThrow();
  });

  // SWIFT-AUD-D6-06: the default 'local' storage provider writes uploads/KYC
  // documents to one instance's disk — fragmenting on multi-instance deploys
  // and sitting outside the backup story. Production must pick a real
  // provider, or explicitly acknowledge a single-instance pilot.
  it('refuses to boot in production with STORAGE_PROVIDER unset (defaults to local disk)', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: undefined })).toThrow(/STORAGE_PROVIDER/);
  });

  it('refuses local storage in production without the explicit acknowledgement', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'local' })).toThrow(/STORAGE_PROVIDER/);
  });

  it('allows local storage in production only with STORAGE_ALLOW_LOCAL=1 (deliberate pilot)', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'local', STORAGE_ALLOW_LOCAL: '1' })).not.toThrow();
  });

  it('accepts the real object-storage providers', () => {
    expect(() => assertSafeBootConfig({ ...good, STORAGE_PROVIDER: 'r2' })).not.toThrow();
  });

  it('does NOT enforce any of this outside production (dev/test boot freely)', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', DEV_OTP_BYPASS: '1' })).not.toThrow();
  });
});

// SWIFT-010: a production DB with no CountryConfig rows has no active market,
// so countryFromPhone rejects every signup — a healthy-looking but dead front
// door. The boot must refuse it. Uses a mock prisma so the guard is proven
// without a database.
const prismaWith = (n: number) => ({ countryConfig: { count: async () => n } });

describe('assertProductionData — fail-closed empty-market guard', () => {
  it('refuses to boot in production when zero CountryConfig rows exist', async () => {
    await expect(assertProductionData(prismaWith(0), { NODE_ENV: 'production' })).rejects.toThrow(/CountryConfig/);
  });

  it('boots in production once at least one CountryConfig (market) is seeded', async () => {
    await expect(assertProductionData(prismaWith(1), { NODE_ENV: 'production' })).resolves.toBeUndefined();
  });

  it('does not query or block outside production, even on an empty DB', async () => {
    let queried = false;
    const spy = { countryConfig: { count: async () => { queried = true; return 0; } } };
    await expect(assertProductionData(spy, { NODE_ENV: 'test' })).resolves.toBeUndefined();
    await expect(assertProductionData(spy, { NODE_ENV: 'development' })).resolves.toBeUndefined();
    expect(queried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [F-027-15] The refusal also lives at the HAZARD, not only at the boot gate.
//
// assertSafeBootConfig is called by exactly two entry points — the server and
// the worker. The repo also ships a production-targeted session-assurance
// cutover script that constructs Fastify and AuthService directly, so it
// selected DevPush in production with nothing to stop it, and any future
// script would have done the same. A guard you have to remember to call is a
// guard that eventually is not called.
//
// DevPush drops every notification on the floor while reporting success. In
// production that means no dispatch offers, no new-order alerts, no safety
// pings — and nothing in the logs to say so.
// ---------------------------------------------------------------------------
describe('[F-027-15] getPushProvider refuses the in-memory provider in production', () => {
  const restore = { env: process.env['NODE_ENV'], push: process.env['PUSH_PROVIDER'] };
  afterEach(() => {
    if (restore.env === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = restore.env;
    if (restore.push === undefined) delete process.env['PUSH_PROVIDER']; else process.env['PUSH_PROVIDER'] = restore.push;
  });

  it('throws when PUSH_PROVIDER is explicitly dev in production', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    process.env['NODE_ENV'] = 'production';
    process.env['PUSH_PROVIDER'] = 'dev';
    expect(() => getPushProvider()).toThrow(/PUSH_PROVIDER is dev/);
  });

  it('throws when PUSH_PROVIDER is UNSET in production — the default is the hazard', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    process.env['NODE_ENV'] = 'production';
    delete process.env['PUSH_PROVIDER'];
    expect(() => getPushProvider()).toThrow(/PUSH_PROVIDER is dev/);
  });

  it('still returns the real provider in production when it is configured', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    process.env['NODE_ENV'] = 'production';
    process.env['PUSH_PROVIDER'] = 'expo';
    expect(() => getPushProvider()).not.toThrow();
  });

  it('leaves dev and test alone — the in-memory provider is correct there', async () => {
    const { getPushProvider } = await import('../providers/notifications/channels');
    for (const env of ['development', 'test']) {
      process.env['NODE_ENV'] = env;
      process.env['PUSH_PROVIDER'] = 'dev';
      expect(() => getPushProvider(), env).not.toThrow();
    }
  });
});

// [V8] CONSENT_IP_PEPPER degrades silently (hashIp → null, attribution just
// stops). Boot must at least be LOUD about it — a warning, not a refusal,
// because the ledger's core evidence still writes without it.
describe('CONSENT_IP_PEPPER visibility [V8]', () => {
  it('warns at production boot when the pepper is missing or short', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertSafeBootConfig({ ...good });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONSENT_IP_PEPPER'));
      warn.mockClear();
      assertSafeBootConfig({ ...good, CONSENT_IP_PEPPER: 'short' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CONSENT_IP_PEPPER'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when a 32+ character pepper is configured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertSafeBootConfig({ ...good, CONSENT_IP_PEPPER: 'p'.repeat(32) });
      const pepperWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('CONSENT_IP_PEPPER'));
      expect(pepperWarnings).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
