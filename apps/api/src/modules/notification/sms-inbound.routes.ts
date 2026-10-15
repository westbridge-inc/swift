import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveIdentityByPhone } from '../auth/preauth-identity';
import { setMarketingConsent } from '../legal/marketing-consent';
import { runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { inboundStopConfigured, isStopKeyword } from './marketing-message';

/**
 * [R22 · research B13 · DPA s.17(2)-(3)] A texted STOP works: a reply of STOP (or another
 * opt-out keyword) to Swift's number withdraws the sender's marketing consent in the ledger,
 * exactly as the app's Account → Marketing messages switch does (surface 'sms').
 *
 * Twilio posts each incoming text here (the number's "A message comes in" webhook).
 *  - Only a request Twilio signed is read: X-Twilio-Signature = base64 HMAC-SHA1 of the exact
 *    URL Twilio called followed by every form field (name then value, names sorted), keyed by
 *    the account's auth token. Anything else is refused before the body is used.
 *  - Off until both settings exist (TWILIO_AUTH_TOKEN, entered by the owner at a hidden prompt,
 *    and TWILIO_INBOUND_SMS_URL, the URL set in Twilio): until then it answers 503 and records
 *    nothing — and no marketing text can be sent (marketing-message.ts STOP_NOT_READY).
 *  - The number and the words are never logged. An unknown number, or words that are not an
 *    opt-out keyword, change nothing.
 * Withdrawing marketing never touches service texts (codes, orders, safety).
 */

export const SMS_INBOUND_BODY_LIMIT = 16 * 1024;
const SMS_INBOUND_RATE = { max: 120, timeWindow: '1 minute' } as const;
const MAX_FIELDS = 64;

/** The reply to a STOP: who it is from, what stopped, what continues (GSM-7, one part). */
export const STOP_CONFIRMATION = 'Swift: you will get no more marketing messages. Texts about your account, orders and safety still come.';

type FormFields = Record<string, string[]>;

function parseForm(text: string): FormFields {
  const out: FormFields = Object.create(null);
  let count = 0;
  for (const [key, value] of new URLSearchParams(text)) {
    if (++count > MAX_FIELDS) throw new Error('too many form fields');
    (out[key] ??= []).push(value);
  }
  return out;
}

function isFormFields(value: unknown): value is FormFields {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

/** Twilio's request signature over `url` and the posted form fields. */
export function twilioSignature(authToken: string, url: string, fields: FormFields): string {
  const data = Object.keys(fields).sort().reduce((acc, key) => acc + [...fields[key]!].sort().map((v) => key + v).join(''), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function signatureValid(header: unknown, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function twiml(reply: FastifyReply, message?: string) {
  return reply.type('text/xml').send(message ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xml(message)}</Message></Response>` : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

export async function smsInboundRoutes(app: FastifyInstance): Promise<void> {
  // Twilio posts a form; scoped to these routes (the server has no global form parser).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: SMS_INBOUND_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, parseForm(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post('/inbound', {
    bodyLimit: SMS_INBOUND_BODY_LIMIT,
    config: { rateLimit: { ...SMS_INBOUND_RATE, keyGenerator: (request: FastifyRequest) => request.ip } },
  }, async (request, reply) => {
    if (!inboundStopConfigured()) {
      log().error('[R22] inbound SMS arrived but STOP handling is not configured (TWILIO_AUTH_TOKEN / TWILIO_INBOUND_SMS_URL); nothing recorded');
      return reply.code(503).type('text/plain').send('not configured');
    }
    // Only the form this route parses is ever signed by the provider; any other body is refused.
    const fields = isFormFields(request.body) ? request.body : null;
    const expected = fields && twilioSignature(process.env['TWILIO_AUTH_TOKEN']!.trim(), process.env['TWILIO_INBOUND_SMS_URL']!.trim(), fields);
    if (!fields || !expected || !signatureValid(request.headers['x-twilio-signature'], expected)) {
      log().warn('[R22] inbound SMS refused: missing or wrong Twilio signature');
      return reply.code(403).type('text/plain').send('forbidden');
    }
    const from = fields['From']?.[0] ?? '';
    const words = fields['Body']?.[0] ?? '';
    if (!isStopKeyword(words) || !/^\+[1-9]\d{6,14}$/.test(from)) return twiml(reply);

    const identity = await resolveIdentityByPhone(app.prisma, from);
    if (identity) {
      const outcome = await runWithTenant(identity.tenantId, () => setMarketingConsent(app.prisma, {
        userId: identity.id, granted: false, surface: 'sms', ip: null,
        evidence: { control: 'sms_stop', keyword: words.trim().replace(/[.!]+$/, '').toUpperCase(), messageSid: fields['MessageSid']?.[0] ?? null },
      }));
      log().info({ changed: outcome.changed }, '[R22] texted STOP: marketing consent withdrawn');
    }
    // The same answer whether or not the number has an account: no oracle.
    return twiml(reply, STOP_CONFIRMATION);
  });
}
