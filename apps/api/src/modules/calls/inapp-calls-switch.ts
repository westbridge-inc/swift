import crypto from 'node:crypto';
import {
  CALL_RELAY_DEFAULT_MAX_ATTEMPTS,
  CALL_RELAY_DEFAULT_MAX_CALL_MINUTES,
  CALL_RELAY_DEFAULT_MAX_CALLS_PER_CUSTOMER_PER_DAY,
  CALL_RELAY_DEFAULT_MAX_CALLS_PER_DAY,
  CALL_RELAY_DEFAULT_MAX_CALLS_PER_PARTNER_PER_DAY,
  CALL_RELAY_MAX_ATTEMPTS_ENV,
  CALL_RELAY_MAX_CALL_MINUTES_ENV,
  CALL_RELAY_MAX_CALLS_PER_CUSTOMER_PER_DAY_ENV,
  CALL_RELAY_MAX_CALLS_PER_DAY_CEILING,
  CALL_RELAY_MAX_CALLS_PER_DAY_ENV,
  CALL_RELAY_MAX_CALLS_PER_PARTNER_PER_DAY_ENV,
  CALL_RELAY_MAX_CALLS_PER_PERSON_CEILING,
  CALL_RELAY_MIN_CALL_MINUTES,
  CALL_RELAY_WEBHOOK_BASE_ENV,
  CALL_TIME_LIMIT_SECONDS,
} from './call-relay-switch';

/**
 * [INAPP-CALLS · owner 6 Nov 2026, "B"] In-app calling: the switch and its settings.
 *
 * A party to a live order taps "Call in app": the call goes over the internet
 * (Twilio Voice) and the other person's phone shows a full call screen,
 * "Swift: your rider is calling about your order" — role words, never a number.
 * Phones that cannot take it (old builds, no data, no answer) fall back to the
 * phone-network bridge (CALL_RELAY) in the same call.
 *
 * OFF by default, and it ships OFF ("dark"): it needs build 13 (native code),
 * the Twilio TwiML App and push credentials, and the privacy wording first.
 * While it is off: no token is issued, no call is started, nothing is written.
 */

export const INAPP_CALLS_ENV = 'INAPP_CALLS';
export const INAPP_CALLS_TWIML_APP_SID_ENV = 'INAPP_CALLS_TWIML_APP_SID';
export const INAPP_CALLS_PUSH_CREDENTIAL_IOS_ENV = 'INAPP_CALLS_PUSH_CREDENTIAL_IOS';
export const INAPP_CALLS_PUSH_CREDENTIAL_ANDROID_ENV = 'INAPP_CALLS_PUSH_CREDENTIAL_ANDROID';
/** Keys the opaque Twilio identity (never a phone number, never the account id itself). */
export const INAPP_CALLS_IDENTITY_SECRET_ENV = 'INAPP_CALLS_IDENTITY_SECRET';

/** How long an issued access token lives. Twilio allows up to 24 hours; Swift keeps it short. */
export const INAPP_TOKEN_TTL_SECONDS = 15 * 60;
/** How long the other person's app rings before Swift tries their phone instead. */
export const INAPP_RING_SECONDS = 20;
/** A started in-app call that Twilio never took (the phone failed to connect) frees the order after this. */
export const INAPP_UNTAKEN_AFTER_MS = 60_000;
/** The most app installs rung at once for one store (owner + staff seats). */
export const INAPP_MAX_CLIENTS = 10;

export type InAppPlatform = 'ios' | 'android';

export interface InAppCallsConfig {
  webhookBase: string;
  maxAttemptsPerOrder: number;
  /** [owner 6 Nov] The phone bridge's daily caps and call length, read from the SAME settings: one budget for
   *  every Swift call, in the app or through the bridge (an in-app call can fall back to a paid phone leg). */
  maxCallsPerDay: number;
  maxCallsPerCustomerPerDay: number;
  maxCallsPerPartnerPerDay: number;
  /** Seconds a call may last (CALL_RELAY_MAX_CALL_MINUTES, default 10 minutes). */
  maxCallSeconds: number;
  twimlAppSid: string;
  pushCredential: Record<InAppPlatform, string>;
  identitySecret: string;
  twilio: { accountSid: string; apiKeySid: string; apiKeySecret: string; authToken: string };
}

/** On only when exactly "1" (surrounding blanks ignored); anything else is off. */
export function inAppCallsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[INAPP_CALLS_ENV] ?? '').trim() === '1';
}

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const APP_SID = /^AP[0-9a-fA-F]{32}$/;
const CREDENTIAL_SID = /^CR[0-9a-fA-F]{32}$/;

/** The settings, or the names of the ones missing or malformed (never their values). */
export function readInAppCallsConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: InAppCallsConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const webhookBase = (env[CALL_RELAY_WEBHOOK_BASE_ENV] ?? '').trim();
  let baseOk = false;
  try {
    const u = new URL(webhookBase);
    baseOk = u.protocol === 'https:' && !u.search && !u.hash && !webhookBase.endsWith('/');
  } catch { baseOk = false; }
  if (!baseOk) problems.push(`${CALL_RELAY_WEBHOOK_BASE_ENV} must be the public https address of the call webhooks (no trailing slash)`);
  const rawMax = (env[CALL_RELAY_MAX_ATTEMPTS_ENV] ?? '').trim();
  const maxAttemptsPerOrder = rawMax === '' ? CALL_RELAY_DEFAULT_MAX_ATTEMPTS : /^\d{1,2}$/.test(rawMax) ? Number(rawMax) : NaN;
  if (!(maxAttemptsPerOrder >= 1 && maxAttemptsPerOrder <= 20)) problems.push(`${CALL_RELAY_MAX_ATTEMPTS_ENV} must be a whole number from 1 to 20`);
  // [owner 6 Nov] The same caps and call length as the bridge (call-relay-switch.ts reads them the same way).
  const whole = (name: string, fallback: number, digits: number, min: number, max: number): number => {
    const raw = (env[name] ?? '').trim();
    const value = raw === '' ? fallback : new RegExp(`^\\d{1,${digits}}$`).test(raw) ? Number(raw) : NaN;
    if (!(value >= min && value <= max)) problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const maxCallsPerDay = whole(CALL_RELAY_MAX_CALLS_PER_DAY_ENV, CALL_RELAY_DEFAULT_MAX_CALLS_PER_DAY, 5, 1, CALL_RELAY_MAX_CALLS_PER_DAY_CEILING);
  const maxCallsPerCustomerPerDay = whole(CALL_RELAY_MAX_CALLS_PER_CUSTOMER_PER_DAY_ENV, CALL_RELAY_DEFAULT_MAX_CALLS_PER_CUSTOMER_PER_DAY, 3, 1, CALL_RELAY_MAX_CALLS_PER_PERSON_CEILING);
  const maxCallsPerPartnerPerDay = whole(CALL_RELAY_MAX_CALLS_PER_PARTNER_PER_DAY_ENV, CALL_RELAY_DEFAULT_MAX_CALLS_PER_PARTNER_PER_DAY, 3, 1, CALL_RELAY_MAX_CALLS_PER_PERSON_CEILING);
  const maxCallSeconds = whole(CALL_RELAY_MAX_CALL_MINUTES_ENV, CALL_RELAY_DEFAULT_MAX_CALL_MINUTES, 2, CALL_RELAY_MIN_CALL_MINUTES, CALL_TIME_LIMIT_SECONDS / 60) * 60;
  const twimlAppSid = (env[INAPP_CALLS_TWIML_APP_SID_ENV] ?? '').trim();
  if (!APP_SID.test(twimlAppSid)) problems.push(`${INAPP_CALLS_TWIML_APP_SID_ENV} must be the TwiML App SID (AP...)`);
  const ios = (env[INAPP_CALLS_PUSH_CREDENTIAL_IOS_ENV] ?? '').trim();
  const android = (env[INAPP_CALLS_PUSH_CREDENTIAL_ANDROID_ENV] ?? '').trim();
  if (!CREDENTIAL_SID.test(ios)) problems.push(`${INAPP_CALLS_PUSH_CREDENTIAL_IOS_ENV} must be the iPhone push credential SID (CR...)`);
  if (!CREDENTIAL_SID.test(android)) problems.push(`${INAPP_CALLS_PUSH_CREDENTIAL_ANDROID_ENV} must be the Android push credential SID (CR...)`);
  const identitySecret = env[INAPP_CALLS_IDENTITY_SECRET_ENV] ?? '';
  if (identitySecret.trim().length < 32) problems.push(`${INAPP_CALLS_IDENTITY_SECRET_ENV} must be at least 32 characters`);
  const accountSid = env['TWILIO_ACCOUNT_SID'] ?? '';
  const apiKeySid = env['TWILIO_API_KEY_SID'] ?? '';
  const apiKeySecret = (env['TWILIO_API_KEY_SECRET'] ?? '').trim();
  const authToken = (env['TWILIO_WEBHOOK_AUTH_TOKEN'] ?? '').trim();
  if (!ACCOUNT_SID.test(accountSid)) problems.push('TWILIO_ACCOUNT_SID is missing or malformed');
  if (!API_KEY_SID.test(apiKeySid)) problems.push('TWILIO_API_KEY_SID is missing or malformed');
  if (!apiKeySecret) problems.push('TWILIO_API_KEY_SECRET is missing');
  if (!authToken) problems.push('TWILIO_WEBHOOK_AUTH_TOKEN is missing (every call webhook is signature-checked with it)');
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      webhookBase, maxAttemptsPerOrder, maxCallsPerDay, maxCallsPerCustomerPerDay, maxCallsPerPartnerPerDay, maxCallSeconds,
      twimlAppSid, identitySecret,
      pushCredential: { ios, android },
      twilio: { accountSid, apiKeySid, apiKeySecret, authToken },
    },
  };
}

/**
 * Boot guard, every mode: INAPP_CALLS=1 with a setting missing or malformed refuses to start.
 * Switched on half-configured, every "Call in app" would fail. Names the settings, never their values.
 */
export function assertInAppCallsConfig(env: Record<string, string | undefined> = process.env): void {
  if (!inAppCallsEnabled(env)) return;
  const read = readInAppCallsConfig(env);
  if (!read.ok) {
    throw new Error(`FATAL: INAPP_CALLS=1 but in-app calling is not configured: ${read.problems.join('; ')}. Set them or leave INAPP_CALLS off. Refusing to start.`);
  }
}

/**
 * The Twilio client identity of ONE signed-in phone: opaque, recomputable, never a number.
 * "s" + 40 hex of HMAC-SHA256(secret, userId + session id + device id): letters and digits only (Twilio:
 * alphanumeric and underscore). [SECURITY REVIEW, MEDIUM] It is per session, not per person: a sign-out
 * deletes the session row and the next sign-in has a new id, so the identity rotates, and Swift only ever
 * rings the identities of a person's CURRENT sessions. A phone still registered under an old identity (the
 * app could not unregister: offline, refused) can never be rung for anyone again.
 */
export function inAppIdentity(secret: string, userId: string, sessionId: string, deviceId: string): string {
  return `s${crypto.createHmac('sha256', secret).update(`swift-inapp-calls:v2:${userId}:${sessionId}:${deviceId}`).digest('hex').slice(0, 40)}`;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * A Twilio Access Token with an identity and a VoiceGrant, minted with node:crypto (no SDK on the server).
 * Shape from twilio-node 6.3.0 lib/jwt/AccessToken.js: header {alg HS256, typ JWT, cty "twilio-fpa;v=1"};
 * payload {jti "<key>-<now>", iss <key>, sub <account>, iat, exp, grants {identity, voice}}.
 */
export function mintVoiceAccessToken(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  identity: string;
  twimlAppSid: string;
  pushCredentialSid: string;
  ttlSeconds: number;
  now?: Date;
}): string {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${input.apiKeySid}-${iat}`,
    iss: input.apiKeySid,
    sub: input.accountSid,
    iat,
    exp: iat + input.ttlSeconds,
    grants: {
      identity: input.identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: input.twimlAppSid },
        push_credential_sid: input.pushCredentialSid,
      },
    },
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', input.apiKeySecret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}
