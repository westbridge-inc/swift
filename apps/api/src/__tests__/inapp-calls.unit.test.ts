import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TwilioVoiceProvider } from '../providers/voice/twilio-voice';
import {
  assertInAppCallsConfig,
  inAppCallsEnabled,
  inAppIdentity,
  mintVoiceAccessToken,
  readInAppCallsConfig,
} from '../modules/calls/inapp-calls-switch';
import { callScreenLine, INAPP_STEPS } from '../modules/calls/inapp-calls';
import { assertSafeBootConfig } from '../utils/boot-config';
import { SECRET_FILE_NAMES } from '../utils/secret-files';

// ---------------------------------------------------------------------------
// [INAPP-CALLS] The pure parts: the switch and its settings, the boot guard, the
// opaque identity, the access token's exact shape, the call-screen words, the
// document that rings the other app, and the one migration.
// ---------------------------------------------------------------------------

const SID = `AC${'a'.repeat(32)}`;
const KEY = `SK${'b'.repeat(32)}`;
const full = (over: Record<string, string | undefined> = {}) => ({
  INAPP_CALLS: '1', CALL_RELAY_WEBHOOK_BASE: 'https://api.example.test/api/v1/calls/voice',
  INAPP_CALLS_TWIML_APP_SID: `AP${'c'.repeat(32)}`, INAPP_CALLS_PUSH_CREDENTIAL_IOS: `CR${'d'.repeat(32)}`, INAPP_CALLS_PUSH_CREDENTIAL_ANDROID: `CR${'e'.repeat(32)}`,
  INAPP_CALLS_IDENTITY_SECRET: 'x'.repeat(32),
  TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: 'unit-secret', TWILIO_WEBHOOK_AUTH_TOKEN: 'unit-token', ...over,
});

describe('[INAPP-CALLS] the switch', () => {
  it('is on only at exactly "1" (blanks ignored); anything else is off', () => {
    expect(inAppCallsEnabled({})).toBe(false);
    for (const v of ['', '0', 'true', 'yes', '2', '01', 'on']) expect(inAppCallsEnabled({ INAPP_CALLS: v }), v).toBe(false);
    for (const v of ['1', ' 1', '1 ']) expect(inAppCallsEnabled({ INAPP_CALLS: v }), v).toBe(true);
  });

  it('the settings: every one is named when missing or malformed, never its value', () => {
    expect(readInAppCallsConfig(full()).ok).toBe(true);
    const bad = readInAppCallsConfig(full({
      CALL_RELAY_WEBHOOK_BASE: 'http://x.test/', INAPP_CALLS_TWIML_APP_SID: 'APnope', INAPP_CALLS_PUSH_CREDENTIAL_IOS: undefined,
      INAPP_CALLS_PUSH_CREDENTIAL_ANDROID: 'CR1', INAPP_CALLS_IDENTITY_SECRET: 'short-secret-value', TWILIO_API_KEY_SECRET: ' ',
    }));
    expect(bad.ok).toBe(false);
    const problems = (bad as { problems: string[] }).problems.join(' | ');
    for (const name of ['CALL_RELAY_WEBHOOK_BASE', 'INAPP_CALLS_TWIML_APP_SID', 'INAPP_CALLS_PUSH_CREDENTIAL_IOS', 'INAPP_CALLS_PUSH_CREDENTIAL_ANDROID', 'INAPP_CALLS_IDENTITY_SECRET', 'TWILIO_API_KEY_SECRET']) {
      expect(problems).toContain(name);
    }
    expect(problems).not.toContain('short-secret-value');
  });

  it('boot: INAPP_CALLS=1 half-configured refuses to start in every mode; off checks nothing', () => {
    expect(() => assertInAppCallsConfig(full({ INAPP_CALLS_TWIML_APP_SID: undefined }))).toThrow(/INAPP_CALLS=1 but in-app calling is not configured: INAPP_CALLS_TWIML_APP_SID/);
    expect(() => assertInAppCallsConfig(full())).not.toThrow();
    expect(() => assertInAppCallsConfig({ INAPP_CALLS: '0' })).not.toThrow();
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', ...full({ INAPP_CALLS_IDENTITY_SECRET: undefined }) })).toThrow(/INAPP_CALLS=1 but in-app calling is not configured/);
  });

  it('the identity key is a store secret (NAME_FILE), never a compose value', () => {
    expect(SECRET_FILE_NAMES).toContain('INAPP_CALLS_IDENTITY_SECRET');
  });
});

describe('[INAPP-CALLS] identity and token', () => {
  it('the identity is opaque, stable, per secret, and only letters and digits (Twilio: alphanumeric and underscore)', () => {
    const a = inAppIdentity('k'.repeat(32), 'cuser1');
    expect(a).toMatch(/^s[0-9a-f]{40}$/);
    expect(inAppIdentity('k'.repeat(32), 'cuser1')).toBe(a);
    expect(inAppIdentity('k'.repeat(32), 'cuser2')).not.toBe(a);
    expect(inAppIdentity('j'.repeat(32), 'cuser1')).not.toBe(a);
    expect(a).not.toContain('cuser1');
  });

  it('the token is twilio-node\'s exact shape, HS256 over the API key secret', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    const token = mintVoiceAccessToken({ accountSid: SID, apiKeySid: KEY, apiKeySecret: 'sekrit', identity: 'sabc', twimlAppSid: `AP${'c'.repeat(32)}`, pushCredentialSid: `CR${'d'.repeat(32)}`, ttlSeconds: 900, now });
    const [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
    const iat = Math.floor(now.getTime() / 1000);
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      jti: `${KEY}-${iat}`, iss: KEY, sub: SID, iat, exp: iat + 900,
      grants: { identity: 'sabc', voice: { incoming: { allow: true }, outgoing: { application_sid: `AP${'c'.repeat(32)}` }, push_credential_sid: `CR${'d'.repeat(32)}` } },
    });
    expect(s).toBe(crypto.createHmac('sha256', 'sekrit').update(`${h}.${p}`).digest('base64url'));
  });
});

describe('[INAPP-CALLS] what the other person sees and what Twilio runs', () => {
  it('the call screen line: "Swift:" + role words, never a name or a number', () => {
    expect(callScreenLine('rider', 'FOOD_DELIVERY')).toBe('Swift: your rider is calling about your order');
    expect(callScreenLine('customer', 'FOOD_DELIVERY')).toBe('Swift: your customer is calling about your order');
    expect(callScreenLine('customer', 'TAXI')).toBe('Swift: your passenger is calling about your order');
    expect(callScreenLine('driver', 'TAXI')).toBe('Swift: your driver is calling about your order');
    expect(callScreenLine('store', 'FOOD_DELIVERY')).toBe('Swift: the store is calling about your order');
  });

  it('dialApp rings each app install, never records, caps at 30 minutes, escapes what it writes', () => {
    const twilio = new TwilioVoiceProvider({ accountSid: SID, apiKeySid: KEY, apiKeySecret: 'x', authToken: 'y' });
    const out = twilio.render({
      verb: 'dialApp', clients: ['sone', 'stwo'], callerId: 'client:Swift', params: { swiftLine: 'a "b" & <c>' },
      answered: 'https://h.test/app-answered?s=c1&x=2', done: 'https://h.test/app-dial-done?s=c1', ringSeconds: 20, limitSeconds: 1800,
    });
    expect(out.contentType).toBe('text/xml');
    expect(out.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response>'
      + '<Dial callerId="client:Swift" timeout="20" timeLimit="1800" record="do-not-record" action="https://h.test/app-dial-done?s=c1" method="POST">'
      + '<Client url="https://h.test/app-answered?s=c1&amp;x=2" method="POST"><Identity>sone</Identity><Parameter name="swiftLine" value="a &quot;b&quot; &amp; &lt;c&gt;"/></Client>'
      + '<Client url="https://h.test/app-answered?s=c1&amp;x=2" method="POST"><Identity>stwo</Identity><Parameter name="swiftLine" value="a &quot;b&quot; &amp; &lt;c&gt;"/></Client>'
      + '</Dial></Response>');
  });

  it('the webhook steps are the TwiML App\'s voice URL, its status callback, and Swift\'s own two', () => {
    expect([...INAPP_STEPS]).toEqual(['app', 'app-answered', 'app-dial-done', 'app-status']);
  });
});

describe('[INAPP-CALLS] the one migration', () => {
  const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
  const NAME = '20261106100000_call_sessions_in_app';
  const read = (f: string) => readFileSync(path.join(MIGRATIONS, NAME, f), 'utf8');
  it('ships once with its rollback, after main\'s newest, and only widens the status CHECK by RINGING_APP', () => {
    expect(existsSync(path.join(MIGRATIONS, NAME, 'rollback.sql'))).toBe(true);
    expect(readdirSync(MIGRATIONS)).toContain('20261105190000_in_person_fee_cash_account');
    expect(NAME > '20261105190000_in_person_fee_cash_account').toBe(true);
    const sql = read('migration.sql').replace(/\s+/g, ' ');
    expect(sql).toContain(`CHECK ("status" IN ('DIALING_CALLER', 'CALLER_CONFIRMED', 'CONNECTED', 'NOT_CONNECTED', 'FAILED', 'RINGING_APP'))`);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|INDEX)|ADD COLUMN/);
  });
  it('the rollback refuses while an in-app call rings, reads past the forced wall, restores the old CHECK and its ledger row', () => {
    const rollback = read('rollback.sql');
    expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM "call_sessions" WHERE "status" = 'RINGING_APP'\) THEN\s+RAISE EXCEPTION/);
    const lines = rollback.split('\n').map((l) => l.trim());
    expect(lines.slice(lines.indexOf('BEGIN;') + 1).find((l) => l !== '' && !l.startsWith('--'))).toBe('SET LOCAL row_security = off;');
    expect(rollback.replace(/\s+/g, ' ')).toContain(`CHECK ("status" IN ('DIALING_CALLER', 'CALLER_CONFIRMED', 'CONNECTED', 'NOT_CONNECTED', 'FAILED'))`);
    expect(rollback).toContain(`"migration_name" = '${NAME}'`);
  });
});
