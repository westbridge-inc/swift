import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_FILE_NAMES, applySecretFiles } from '../utils/secret-files';
import { assertSafeBootConfig } from '../utils/boot-config';
import { loadMmgCheckoutConfig } from '../providers/mmg/mmg-checkout';
import { getMmgLookupProvider } from '../providers/mmg/mmg-provider';
import { powerTranzConfigFromEnv } from '../providers/card/powertranz-provider';
import { malformedAllowlistPositions, parseSmsRecipientAllowlist } from '../providers/notifications/sms-recipient-allowlist';
import { firstInvalidTwilioConfig } from '../utils/twilio-identity';

// ---------------------------------------------------------------------------
// [TA-S0-003 · C1] The rehearsal copy (deploy/wall/rehearsal.sh) gives every
// provider secret its processes are wired to read a fresh throwaway stand-in
// (deploy/wall/stand-in.sh): the copy has no route out, so no real value is
// ever needed. On staging (15 Oct) every stand-in was 24 random bytes in hex,
// and the copy's API and worker crash-looped before the wall's attestation:
// staging runs MMG's hosted checkout (its keys must be PEM) and an SMS
// allowlist (E.164), and assertSafeBootConfig refuses both in every mode.
//
// The contract, through the API's own loader and guards: EVERY name the secret
// loader accepts, fed from stand-in.sh through *_FILE exactly as a container
// reads it, in a host posture with every provider switch on, boots. A new
// shape check on any of these names fails here until stand-in.sh learns it.
// Names the rehearsal never stands in: the ones gen-secrets.sh generates
// (fresh, in their own formats) and the two runtime login URLs (published by
// rls-logins) — and REDIS_URL, which Compose sets plainly.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..', '..', '..');
const STAND_IN = join(ROOT, 'deploy', 'wall', 'stand-in.sh');
const generated = (readFileSync(join(ROOT, 'deploy', 'gen-secrets.sh'), 'utf8').match(/^GENERATED="(.*)"$/m)?.[1] ?? '').split(/\s+/).filter(Boolean);
const NOT_STOOD_IN = new Set([...generated, 'DATABASE_URL', 'SYSTEM_DATABASE_URL', 'REDIS_URL']);
const STOOD_IN: readonly string[] = SECRET_FILE_NAMES.filter((name) => !NOT_STOOD_IN.has(name));

/** Sentry's own DSN grammar (@sentry/core dsn.ts): what Sentry.init parses. */
const SENTRY_DSN = /^(?:(\w+):)\/\/(?:(\w+)(?::(\w+)?)?@)([\w.-]+)(?::(\d+))?\/(.+)/;
const LONGEST_MERCHANT_NAME = 'M'.repeat(64);

function standIn(name: string): string {
  const out = spawnSync('bash', [STAND_IN, name], { encoding: 'utf8', timeout: 60_000 });
  expect(out.status, `stand-in.sh ${name}: ${out.stderr}`).toBe(0);
  return out.stdout;
}

/** The generated secrets, in gen-secrets.sh's formats (as rehearsal.sh's gen_value). */
function generatedValue(name: string): string {
  if (name === 'MASTER_KEK') return randomBytes(32).toString('base64');
  if (['POSTGRES_PASSWORD', 'TEST_CONTROL_SECRET', 'METRICS_TOKEN', 'HEALTH_DETAIL_TOKEN'].includes(name)) return randomBytes(32).toString('hex');
  return randomBytes(48).toString('base64').replace(/=/g, '');
}

let dir: string;
const files: Record<string, string> = {};
const values: Record<string, string> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rehearsal-stand-ins-'));
  for (const name of [...STOOD_IN, ...generated.filter((n) => n !== 'POSTGRES_PASSWORD')]) {
    const value = STOOD_IN.includes(name) ? standIn(name) : generatedValue(name);
    const path = join(dir, name);
    writeFileSync(path, value, { mode: 0o600 });
    files[`${name}_FILE`] = path;
    // What the loader makes of it: one trailing newline dropped.
    if (STOOD_IN.includes(name)) values[name] = value.replace(/\r?\n$/, '');
  }
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A host's settings (every provider switch its posture allows turned on) over the secret files, loaded as a container loads them. */
function loaded(settings: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...files, ...settings };
  applySecretFiles(env);
  return env;
}

const twilio = {
  NOTIFICATION_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_FROM: '+15550000000',
};
const mmgCheckout = {
  MMG_DRIVER: 'live',
  MMG_API_URL: 'https://uat.mmg.invalid',
  MMG_MERCHANT_ID: '5920000009',
  MMG_CHECKOUT_ENABLED: '1',
  MMG_CHECKOUT_MERCHANT_ID: '5920001',
  MMG_CHECKOUT_CLIENT_ID: 'synthetic-client',
  MMG_CHECKOUT_MERCHANT_NAME: LONGEST_MERCHANT_NAME,
  MMG_CHECKOUT_CREATION_ZONE: 'GUYANA_WALL_CLOCK',
};

describe('rehearsal stand-ins pass the API boot guards (deploy/wall/stand-in.sh)', () => {
  it('covers every name the secret loader accepts but the generated ones and the URLs', () => {
    expect(generated.length).toBeGreaterThan(10);
    expect(STOOD_IN).toEqual(expect.arrayContaining(['MMG_CHECKOUT_PUBLIC_KEY', 'MMG_CHECKOUT_PRIVATE_KEY', 'SMS_RECIPIENT_ALLOWLIST', 'POWERTRANZ_GATEWAY_KEY']));
    for (const name of STOOD_IN) expect(files[`${name}_FILE`], name).toBeTruthy();
  });

  it("staging's posture (loadtest): MMG checkout live, an SMS allowlist, Twilio, the PowerTranz sandbox — every guard holds", () => {
    const env = loaded({
      NODE_ENV: 'loadtest',
      PILOT_ENV: 'staging',
      STORAGE_DEPLOYMENT: 'managed',
      STORAGE_PROVIDER: 's3',
      AWS_S3_BUCKET: 'synthetic-copy-bucket',
      API_PUBLIC_URL: 'https://api-staging.example.test',
      ...twilio,
      ...mmgCheckout,
      MMG_CHECKOUT_RETURN_ORIGIN: 'https://api-staging.example.test',
      TEST_CONTROL_ENABLED: '1',
      CARD_RAIL_PROVIDER: 'powertranz',
      CARD_RAIL_ENVIRONMENT: 'sandbox',
      CARD_RAIL_ACCOUNT: 'swift-sandbox',
      POWERTRANZ_API_URL: 'https://staging.ptranz.com',
      POWERTRANZ_PAGE_SET: 'PTZ/Swift',
      POWERTRANZ_PAGE_NAME: 'Pay',
      PAYMENT_PROVIDER: 'powertranz',
      PLACES_PROVIDER: 'google',
    });
    expect(() => assertSafeBootConfig(env)).not.toThrow();
    expect(() => loadMmgCheckoutConfig(env)).not.toThrow();
    expect(() => getMmgLookupProvider(env)).not.toThrow();
    expect(() => powerTranzConfigFromEnv(env)).not.toThrow();
    expect(firstInvalidTwilioConfig(env)).toBeNull();
    expect(malformedAllowlistPositions(env['SMS_RECIPIENT_ALLOWLIST'])).toEqual([]);
    expect([...parseSmsRecipientAllowlist(env['SMS_RECIPIENT_ALLOWLIST'])]).toEqual(['+5920000000']);
  }, 60_000);

  it("production's posture: MMG checkout live on its own page, SMTP, Twilio, s3 — every guard holds", () => {
    const env = loaded({
      NODE_ENV: 'production',
      PLACES_PROVIDER: 'osm',
      PHOTON_URL: 'http://photon.test',
      LIFECYCLE_V2: '1',
      ORDER_HOLD_MINUTES: '5',
      STORAGE_PROVIDER: 's3',
      AWS_S3_BUCKET: 'synthetic-boot-bucket',
      ...twilio,
      PUSH_PROVIDER: 'expo',
      KYC_PROVIDER: 'manual',
      PAYMENT_PROVIDER: 'disabled',
      CARD_RAIL_KILL: '1',
      ...mmgCheckout,
      MMG_API_URL: 'https://api.mmg.gy/olive/publisher/v1',
      MMG_CHECKOUT_URL: 'https://checkout.mmg.invalid/payments',
      MMG_CHECKOUT_RETURN_ORIGIN: 'https://api.example.test',
      MMG_REFERENCE_ROUNDTRIP_VERIFIED: '1',
      OPS_ONCALL_PHONES: '+5920000001,+5920000002',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '465',
      SMTP_USER: 'noreply@example.test',
      EMAIL_FROM: 'Swift <noreply@example.test>',
      BILLING_TOPUP_HOLD: '1',
      // Production never wires these (pilot-up refuses them): leave them out of this posture.
      ...Object.fromEntries(['SMS_RECIPIENT_ALLOWLIST', 'AGENT_CASH_WEBHOOK_SECRET', 'POWERTRANZ_ID', 'POWERTRANZ_PASSWORD', 'POWERTRANZ_GATEWAY_KEY',
        'STRIPE_SECRET_KEY', 'PAYMENT_GATEWAY_KEY', 'PAYMENT_GATEWAY_SECRET'].map((n) => [`${n}_FILE`, undefined])),
    });
    expect(() => assertSafeBootConfig(env)).not.toThrow();
    expect(() => loadMmgCheckoutConfig(env)).not.toThrow();
  }, 60_000);

  it('each shaped stand-in is the shape its consumer reads, on no reachable host', () => {
    expect(values['MMG_CHECKOUT_PUBLIC_KEY']).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----$/);
    expect(values['MMG_CHECKOUT_PRIVATE_KEY']).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/);
    expect(values['POWERTRANZ_GATEWAY_KEY']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(values['SENTRY_DSN']).toMatch(SENTRY_DSN);
    for (const name of ['SENTRY_DSN', 'CW_ALERT_WEBHOOK_URL']) {
      const url = new URL(values[name] as string);
      expect(url.protocol, name).toBe('https:');
      expect(url.hostname.endsWith('.invalid'), name).toBe(true);
    }
    expect(values['STRIPE_SECRET_KEY']).toMatch(/^sk_test_[0-9a-f]{48}$/);
  });

  it('every stand-in is fresh: two calls never give the same value', () => {
    for (const name of ['MMG_CHECKOUT_SECRET_KEY', 'POWERTRANZ_GATEWAY_KEY', 'TWILIO_API_KEY_SECRET', 'CW_ALERT_WEBHOOK_URL']) {
      expect(standIn(name), name).not.toBe(standIn(name));
    }
  });
});
