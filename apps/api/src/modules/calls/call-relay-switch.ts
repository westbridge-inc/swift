/**
 * [O-1 · owner 24 Oct 2026] CALL_RELAY: the Swift call bridge's switch.
 *
 * OFF by default, and it ships OFF. It is turned on only after a real Swift
 * test call rings and "Press 1" connects on a Digicel phone AND a GTT phone.
 *
 * While it is OFF nothing about phone numbers changes for anyone (owner,
 * 24 Oct 06:00Z): every app, old store build or new, keeps the other party's
 * number on a live order exactly as today, so no one is left with no way to
 * call at the door. In-app chat works either way.
 */

export const CALL_RELAY_ENV = 'CALL_RELAY';

/** On only when exactly "1" (surrounding blanks ignored); anything else is off. */
export function callRelayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env[CALL_RELAY_ENV] ?? '').trim() === '1';
}

// ---------------------------------------------------------------------------
// [O-1 PR3] What the bridge needs once CALL_RELAY is on. The server refuses to
// start with CALL_RELAY=1 and any of this missing (boot-config.ts), because a
// bridge switched on without it would hide numbers from the new apps and then
// fail every call: worse than off.
// ---------------------------------------------------------------------------

/** Swift's own number the people on a call see: a Twilio number or a Twilio
 *  Verified caller ID, entered by the owner at a hidden prompt (helper 21). */
export const CALL_RELAY_CALLER_ID_ENV = 'CALL_RELAY_CALLER_ID';
/** The exact public https base Twilio is told to call back (signatures cover the URL). */
export const CALL_RELAY_WEBHOOK_BASE_ENV = 'CALL_RELAY_WEBHOOK_BASE';
/** Calls one order may start, connected or not (Swift pays for every attempt). */
export const CALL_RELAY_MAX_ATTEMPTS_ENV = 'CALL_RELAY_MAX_ATTEMPTS_PER_ORDER';
export const CALL_RELAY_DEFAULT_MAX_ATTEMPTS = 6;
/** Owner ruling 22 Oct: a hard 30-minute limit on every call. */
export const CALL_TIME_LIMIT_SECONDS = 1800;
/** How long each phone rings before the leg counts as not answered. */
export const CALL_RING_SECONDS = 25;

export interface CallRelayConfig {
  callerId: string;
  webhookBase: string;
  maxAttemptsPerOrder: number;
  twilio: { accountSid: string; apiKeySid: string; apiKeySecret: string; authToken: string };
}

const E164 = /^\+[1-9]\d{6,14}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;

/** The bridge's settings, or the names of the ones missing or malformed (never their values). */
export function readCallRelayConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: CallRelayConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const callerId = (env[CALL_RELAY_CALLER_ID_ENV] ?? '').trim();
  if (!E164.test(callerId)) problems.push(`${CALL_RELAY_CALLER_ID_ENV} must be Swift's number in +E.164 form`);
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
  const accountSid = env['TWILIO_ACCOUNT_SID'] ?? '';
  const apiKeySid = env['TWILIO_API_KEY_SID'] ?? '';
  const apiKeySecret = (env['TWILIO_API_KEY_SECRET'] ?? '').trim();
  const authToken = (env['TWILIO_WEBHOOK_AUTH_TOKEN'] ?? '').trim();
  if (!ACCOUNT_SID.test(accountSid)) problems.push('TWILIO_ACCOUNT_SID is missing or malformed');
  if (!API_KEY_SID.test(apiKeySid)) problems.push('TWILIO_API_KEY_SID is missing or malformed');
  if (!apiKeySecret) problems.push('TWILIO_API_KEY_SECRET is missing');
  if (!authToken) problems.push('TWILIO_WEBHOOK_AUTH_TOKEN is missing (every call webhook is signature-checked with it)');
  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { callerId, webhookBase, maxAttemptsPerOrder, twilio: { accountSid, apiKeySid, apiKeySecret, authToken } } };
}

/**
 * [O-1] Boot guard, every mode: CALL_RELAY=1 with the bridge's settings missing
 * or malformed refuses to start. Switched on half-configured, the new apps would
 * stop receiving numbers and every Swift call would fail: worse than off, and
 * just as quiet. Names the settings, never their values. Off: nothing is checked.
 */
export function assertCallRelayConfig(env: Record<string, string | undefined> = process.env): void {
  if (!callRelayEnabled(env)) return;
  const read = readCallRelayConfig(env);
  if (!read.ok) {
    throw new Error(`FATAL: CALL_RELAY=1 but the call bridge is not configured: ${read.problems.join('; ')}. Set them (owner helper 21) or leave CALL_RELAY off. Refusing to start.`);
  }
}
