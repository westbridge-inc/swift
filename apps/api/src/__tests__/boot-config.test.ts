import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeBootConfig, assertProductionData } from '../utils/boot-config';

// SWIFT-AUD-D9-02 / D3-01: production must refuse to boot without the two
// secrets that keep KYC documents private (envelope KEK + render HMAC), and
// without the OTP-bypass guard. Non-production is unaffected.

const KEK = Buffer.alloc(32, 7).toString('base64'); // valid 32-byte base64
const good: Record<string, string | undefined> = {
  NODE_ENV: 'production',
  MASTER_KEK: KEK,
  STORAGE_SIGNING_SECRET: 'a-managed-signing-secret-of-at-least-32-chars',
  STORAGE_PROVIDER: 's3',
  NOTIFICATION_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'test-key-secret',
  TWILIO_FROM: '+15550000000',
  PUSH_PROVIDER: 'expo',
  JWT_SECRET: 'test-jwt-secret-at-least-32-characters',
  KYC_PROVIDER: 'manual',
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

const cardOff = {
  ...good,
  PAYMENT_PROVIDER: 'disabled',
  CARD_RAIL_KILL: '1',
  STRIPE_SECRET_KEY: undefined,
  PAYMENT_GATEWAY_KEY: undefined,
  PAYMENT_GATEWAY_SECRET: undefined,
  POWERTRANZ_API_URL: undefined,
};

const paddedTwilioIdentities = ([
  ['TWILIO_ACCOUNT_SID', good['TWILIO_ACCOUNT_SID']],
  ['TWILIO_API_KEY_SID', good['TWILIO_API_KEY_SID']],
  ['TWILIO_FROM', good['TWILIO_FROM']],
] as const).flatMap(([name, valid]) => [' ', '\t', '\r', '\n'].flatMap((whitespace) => [
  { name, value: `${whitespace}${valid}`, position: 'leading', whitespace: JSON.stringify(whitespace) },
  { name, value: `${valid}${whitespace}`, position: 'trailing', whitespace: JSON.stringify(whitespace) },
]));

function runPreflight(candidate: Record<string, string | undefined>) {
  const directory = mkdtempSync(join(tmpdir(), 'swift-twilio-preflight-'));
  try {
    const candidatePath = join(directory, 'candidate.env');
    writeFileSync(candidatePath, Object.entries(candidate)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `${name}=${value}`).join('\n'));
    const tsx = join(process.cwd(), 'node_modules/.bin/tsx');
    const script = join(process.cwd(), '../../deploy/preflight.ts');
    return spawnSync(tsx, [script, candidatePath], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '' },
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe('assertSafeBootConfig — fail-closed production secrets', () => {
  it('boots with the card rail explicitly disabled and no card credentials', () => {
    expect(() => assertSafeBootConfig(cardOff)).not.toThrow();
  });

  it.each([undefined, '', '0', 'true', '01'])('refuses disabled cards with an ineffective kill switch (%s)', (kill) => {
    expect(() => assertSafeBootConfig({ ...cardOff, CARD_RAIL_KILL: kill })).toThrow(/CARD_RAIL_KILL/);
  });

  it.each([undefined, '', 'disable', 'DISABLED', 'disabled ', 'sandbox'])('does not infer card OFF from provider %s', (provider) => {
    expect(() => assertSafeBootConfig({ ...cardOff, PAYMENT_PROVIDER: provider })).toThrow(/PAYMENT_PROVIDER/);
  });

  it.each(['stripe', 'powertranz'])('still requires credentials for %s even with the kill switch on', (provider) => {
    expect(() => assertSafeBootConfig({ ...cardOff, PAYMENT_PROVIDER: provider })).toThrow(/STRIPE_SECRET_KEY|PAYMENT_GATEWAY_KEY/);
  });

  it.each(['MMG_DRIVER', 'MMG_API_URL', 'MMG_API_KEY', 'MMG_MERCHANT_ID', 'MMG_PASSWORD', 'MMG_MKEY', 'MMG_MSECRET'])(
    'still requires %s with cards OFF', (name) => {
      expect(() => assertSafeBootConfig({ ...cardOff, [name]: undefined })).toThrow(/MMG/);
    },
  );

  it('still rejects sandbox and UAT MMG with cards OFF', () => {
    expect(() => assertSafeBootConfig({ ...cardOff, MMG_DRIVER: 'sandbox' })).toThrow(/MMG_DRIVER/);
    expect(() => assertSafeBootConfig({ ...cardOff, MMG_API_URL: 'https://mwallet.mmgtest.net' })).toThrow(/non-UAT/);
  });

  it('preflight accepts explicit card OFF and rejects a reachable card charge rail', () => {
    const off = runPreflight(cardOff);
    expect(off.status, off.stdout + off.stderr).toBe(0);
    const reachable = runPreflight({ ...cardOff, CARD_RAIL_KILL: '0' });
    expect(reachable.status, reachable.stdout + reachable.stderr).toBe(1);
    expect(reachable.stdout).toContain('CARD_RAIL_KILL');
  });

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
    // [M-37] Non-default is not enough: a short secret is a guessable one.
    expect(() => assertSafeBootConfig({ ...good, STORAGE_SIGNING_SECRET: 'short-but-not-default' })).toThrow(/32 characters/);
  });

  it('still refuses DEV_OTP_BYPASS=1 in production', () => {
    expect(() => assertSafeBootConfig({ ...good, DEV_OTP_BYPASS: '1' })).toThrow(/DEV_OTP_BYPASS/);
  });

  it('requires a strong keyed-HMAC secret for OTP records', () => {
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: undefined })).toThrow(/OTP_HASH_SECRET|JWT_SECRET/);
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: 'too-short' })).toThrow(/32 characters/);
    expect(() => assertSafeBootConfig({ ...good, JWT_SECRET: undefined, OTP_HASH_SECRET: 'dedicated-otp-secret-at-least-32-chars' })).not.toThrow();
  });

  it('[NO-AI] refuses every KYC_PROVIDER but manual — the removed providers, the sandbox, unset — in production and everywhere else', () => {
    // The removed provider names are built from fragments so no source file carries them.
    const removed = [['di', 'dit'].join(''), ['id', 'analyzer'].join('')];
    for (const provider of [undefined, '', 'sandbox', 'MANUAL', ...removed]) {
      expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: provider }), `production/${provider}`).toThrow(/KYC_PROVIDER must be 'manual'/);
      for (const mode of ['development', 'test', 'loadtest']) {
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: provider }), `${mode}/${provider}`).toThrow(/KYC_PROVIDER must be 'manual'/);
      }
    }
    // The refusal names the value it saw, never a provider that could be selected instead.
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: 'sandbox' })).toThrow(/got "sandbox"\. No other identity provider exists/);
    expect(() => assertSafeBootConfig({ ...good, KYC_PROVIDER: undefined })).toThrow(/got unset/);
  });

  it('[NO-AI] refuses the two dead face-match switches in every environment; unset or 0 is fine', () => {
    for (const removed of ['FEATURE_BIOMETRIC_FACE_MATCH', 'LIVENESS_REQUIRED']) {
      expect(() => assertSafeBootConfig({ ...good, [removed]: '1' }), removed).toThrow(`${removed}=1 has no implementation`);
      for (const mode of ['development', 'test', 'loadtest']) {
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: 'manual', [removed]: '1' }), `${mode}/${removed}`).toThrow(/no face matching and no selfie identity checks/);
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: 'manual', [removed]: '0' }), `${mode}/${removed}=0`).not.toThrow();
        expect(() => assertSafeBootConfig({ NODE_ENV: mode, KYC_PROVIDER: 'manual', [removed]: '' }), `${mode}/${removed}=`).not.toThrow();
      }
    }
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

  it('refuses incomplete Twilio API-key configuration at production boot', () => {
    for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_FROM'] as const) {
      expect(() => assertSafeBootConfig({ ...good, [name]: undefined }), name).toThrow(name);
      expect(() => assertSafeBootConfig({ ...good, [name]: '   ' }), name).toThrow(name);
    }
    expect(() => assertSafeBootConfig({ ...good, TWILIO_API_KEY_SECRET: undefined, TWILIO_AUTH_TOKEN: 'legacy-token' }))
      .toThrow(/TWILIO_API_KEY_SECRET/);
  });

  it('refuses nonempty malformed Twilio identifiers at production boot', () => {
    for (const [name, value] of [
      ['TWILIO_ACCOUNT_SID', 'not-an-account-sid'],
      ['TWILIO_ACCOUNT_SID', `AC${'g'.repeat(32)}`],
      ['TWILIO_API_KEY_SID', 'not-an-api-key-sid'],
      ['TWILIO_API_KEY_SID', `SK${'g'.repeat(32)}`],
      ['TWILIO_FROM', 'not-a-phone-number'],
    ] as const) {
      expect(() => assertSafeBootConfig({ ...good, [name]: value }), name).toThrow(name);
    }
  });

  it.each(paddedTwilioIdentities)('refuses literal $position $whitespace in $name at boot and preflight guard', ({ name, value }) => {
    expect(() => assertSafeBootConfig({ ...good, [name]: value })).toThrow(name);
  });

  it('accepts exact Twilio values in the value-free preflight CLI', () => {
    const result = runPreflight(good);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('PASS — this configuration will not be refused at boot');
  });

  it.each(paddedTwilioIdentities.filter(({ whitespace }) => whitespace === '" "' || whitespace === '"\\t"'))(
    'preflight CLI refuses unquoted $position $whitespace in $name', ({ name, value }) => {
      const result = runPreflight({ ...good, [name]: value });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`FATAL: ${name} is missing or malformed`);
    },
  );

  it.each(paddedTwilioIdentities.filter(({ whitespace }) => whitespace === '"\\r"' || whitespace === '"\\n"'))(
    'preflight CLI refuses quoted $position $whitespace in $name', ({ name, value }) => {
      const result = runPreflight({ ...good, [name]: `"${value}"` });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(`FATAL: ${name} is missing or malformed`);
    },
  );

  it('refuses an unknown notification adapter at production boot', () => {
    expect(() => assertSafeBootConfig({ ...good, NOTIFICATION_PROVIDER: 'unknown' })).toThrow(/NOTIFICATION_PROVIDER/);
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

  it('[TA-S1-007] refuses to boot on an UNSET or misspelled NODE_ENV — never a quiet development posture', () => {
    expect(() => assertSafeBootConfig({})).toThrow(/NODE_ENV must be exactly one of/);
    for (const bad of ['', 'prod', 'Production', 'productio', 'staging']) {
      expect(() => assertSafeBootConfig({ ...good, NODE_ENV: bad }), bad).toThrow(/NODE_ENV must be exactly one of/);
    }
    // And the guard cannot be waved through by mislabelling a live host.
    expect(() => assertSafeBootConfig({ ...good, NODE_ENV: 'prod', MASTER_KEK: undefined })).toThrow(/NODE_ENV/);
  });

  it('does NOT enforce the production secrets outside production (dev/test/loadtest boot freely); only the no-AI rule applies everywhere', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', KYC_PROVIDER: 'manual' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'loadtest', KYC_PROVIDER: 'manual' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'test', KYC_PROVIDER: 'manual', DEV_OTP_BYPASS: '1' })).not.toThrow();
    // …and a non-production boot with no provider named is the one thing that is NOT free.
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development' })).toThrow(/KYC_PROVIDER must be 'manual'/);
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

  it('[TA-S1-007] refuses an unknown NODE_ENV before it ever queries', async () => {
    // A client that would betray any query: the refusal must come from the
    // mode parse, never from (or after) a database round-trip.
    const never = { countryConfig: { count: async () => { throw new Error('QUERIED'); } } } as never;
    await expect(assertProductionData(never, {})).rejects.toThrow(/NODE_ENV must be exactly one of/);
    await expect(assertProductionData(never, { NODE_ENV: 'prod' })).rejects.toThrow(/NODE_ENV must be exactly one of/);
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
