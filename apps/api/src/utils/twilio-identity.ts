/** Local syntax checks only. Provider ownership, permission and delivery need UAT. */
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const SENDER_NUMBER = /^\+[1-9][0-9]{1,14}$/;
const MESSAGE_SID = /^(?:SM|MM)[0-9a-fA-F]{32}$/;

export function firstInvalidTwilioConfig(env: Record<string, string | undefined>): string | null {
  const accountSid = env['TWILIO_ACCOUNT_SID'] ?? '';
  const keySid = env['TWILIO_API_KEY_SID'] ?? '';
  const keySecret = env['TWILIO_API_KEY_SECRET']?.trim() ?? '';
  const from = env['TWILIO_FROM'] ?? '';

  if (!ACCOUNT_SID.test(accountSid)) return 'TWILIO_ACCOUNT_SID';
  if (!API_KEY_SID.test(keySid)) return 'TWILIO_API_KEY_SID';
  if (!keySecret) return 'TWILIO_API_KEY_SECRET';
  if (!SENDER_NUMBER.test(from)) return 'TWILIO_FROM';
  return null;
}

export function isTwilioMessageSid(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_SID.test(value);
}
