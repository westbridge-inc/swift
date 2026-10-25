/** Local syntax checks only. Provider ownership, permission and delivery need UAT. */
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const SENDER_NUMBER = /^\+[1-9][0-9]{1,14}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/;
const MESSAGE_SID = /^(?:SM|MM)[0-9a-fA-F]{32}$/;

/**
 * The first Twilio configuration problem as a complete, value-free reason
 * (or null when the configuration is usable). Single-field failures keep the
 * historical `X is missing or malformed` wording; callers suffix it with their
 * own context. The sender mutual-exclusion rule adds two richer refusals.
 */
export function firstInvalidTwilioConfig(env: Record<string, string | undefined>): string | null {
  const accountSid = env['TWILIO_ACCOUNT_SID'] ?? '';
  const keySid = env['TWILIO_API_KEY_SID'] ?? '';
  const keySecret = env['TWILIO_API_KEY_SECRET']?.trim() ?? '';
  const from = env['TWILIO_FROM'] ?? '';
  const messagingServiceSid = env['TWILIO_MESSAGING_SERVICE_SID'] ?? '';

  if (!ACCOUNT_SID.test(accountSid)) return 'TWILIO_ACCOUNT_SID is missing or malformed';
  if (!API_KEY_SID.test(keySid)) return 'TWILIO_API_KEY_SID is missing or malformed';
  if (!keySecret) return 'TWILIO_API_KEY_SECRET is missing or malformed';
  // A present-but-garbled sender is named as the single-field error it is,
  // before the exactly-one rule: identity syntax is literal, so a
  // whitespace-padded value fails these checks rather than counting as set.
  if (from && !SENDER_NUMBER.test(from)) return 'TWILIO_FROM is missing or malformed';
  if (messagingServiceSid && !MESSAGING_SERVICE_SID.test(messagingServiceSid)) {
    return 'TWILIO_MESSAGING_SERVICE_SID is missing or malformed';
  }
  // EXACTLY ONE sender: a From number or a Messaging Service SID — never
  // both, never neither.
  if (from && messagingServiceSid) {
    return 'TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID are both set — exactly one of them is required';
  }
  if (!from && !messagingServiceSid) {
    return 'TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID is required — exactly one of them must be set';
  }
  return null;
}

export function isTwilioMessageSid(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_SID.test(value);
}
