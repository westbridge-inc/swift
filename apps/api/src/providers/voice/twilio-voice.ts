import crypto from 'node:crypto';
import { twilioSignature } from '../../modules/notification/sms-inbound.routes';
import type { CallProvider, CallStep, PlaceCallInput, ProviderEvent, ProviderWebhook } from './call-provider';
import { dialableNumber } from './dialable';

/**
 * [O-1] Twilio, adapter #1 of the call bridge. Dependency-free like the SMS
 * adapter (providers/notifications/channels.ts): Node's fetch against Twilio's
 * REST API, credentials from the env (the same account and API key as Swift's
 * texts), never logged, never echoed into an error.
 *
 * From Twilio's own docs (evidence copies, 22-25 Oct 2026):
 * - Calls API (POST /2010-04-01/Accounts/{AccountSid}/Calls.json): To, From
 *   (a Twilio number or a Verified caller ID), Url (TwiML when answered),
 *   StatusCallback + StatusCallbackEvent, Timeout (ring seconds), TimeLimit
 *   (maximum call seconds), Record (default false; Swift writes false).
 * - <Dial callerId timeout timeLimit record action method>: record defaults to
 *   do-not-record; Swift writes it explicitly. callerId is pinned to Swift's
 *   number (never the To number).
 * - <Number url>: TwiML run on the called party's phone after they answer and
 *   before they are connected (only <Say>/<Play>/<Gather>/<Hangup>), so a
 *   voicemail or a carrier announcement is never bridged.
 * - <Gather input="dtmf" numDigits="1" action>: posts Digits to action; with no
 *   input the document continues (here: a goodbye and <Hangup/>).
 * - X-Twilio-Signature: base64 HMAC-SHA1 of the exact URL + sorted form fields,
 *   keyed by the account's auth token (the same check as inbound texts).
 */

export interface TwilioVoiceConfig {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  /** Verification only: the token Twilio signs its webhooks with. */
  authToken: string;
}

const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
/** A hung Twilio must not hang the person's tap: the whole request is bounded. */
export const TWILIO_CALL_TIMEOUT_MS = 10_000;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const doc = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const first = (fields: Record<string, string[]>, name: string) => fields[name]?.[0] ?? null;
/** The one recording attribute Swift ever writes, on every <Dial> (phone or app): never record. */
const NEVER_RECORD = 'record="do-not-record"';

export class TwilioVoiceProvider implements CallProvider {
  readonly name = 'twilio';

  constructor(
    private readonly config: TwilioVoiceConfig,
    private readonly http: typeof fetch = (...args) => fetch(...args),
  ) {}

  async placeCall(input: PlaceCallInput): Promise<{ providerCallId: string }> {
    // [REVIEW-M17 S1-1] The backstop: whatever a caller of this hands in, Twilio is never asked to ring a number
    // the dial guard refuses (never echoed).
    if (!dialableNumber(input.to, input.callerId)) throw new Error('Twilio call refused: not a dialable number');
    const auth = Buffer.from(`${this.config.apiKeySid}:${this.config.apiKeySecret}`).toString('base64');
    const body = new URLSearchParams({
      To: input.to,
      From: input.callerId,
      Url: input.answerUrl,
      Method: 'POST',
      StatusCallback: input.statusUrl,
      StatusCallbackMethod: 'POST',
      Timeout: String(input.ringSeconds),
      TimeLimit: String(input.limitSeconds),
      Record: 'false',
    });
    body.append('StatusCallbackEvent', 'answered');
    body.append('StatusCallbackEvent', 'completed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TWILIO_CALL_TIMEOUT_MS);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.http(`https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch {
      // Never the provider's text: it can echo the numbers back.
      throw new Error(controller.signal.aborted ? 'Twilio call timed out' : 'Twilio call request failed');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Twilio call failed (${res.status})`);
    let data: { sid?: unknown };
    try {
      data = (await res.json()) as { sid?: unknown };
    } catch {
      throw new Error('Twilio call response invalid');
    }
    if (!data || typeof data.sid !== 'string' || !CALL_SID.test(data.sid)) throw new Error('Twilio call response invalid');
    return { providerCallId: data.sid };
  }

  verify(hook: ProviderWebhook): boolean {
    if (typeof hook.signature !== 'string' || hook.signature.length === 0) return false;
    const expected = Buffer.from(twilioSignature(this.config.authToken, hook.url, hook.fields));
    const given = Buffer.from(hook.signature);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  read(fields: Record<string, string[]>): ProviderEvent {
    const seconds = (v: string | null) => (v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null);
    const callSid = first(fields, 'CallSid');
    return {
      digits: first(fields, 'Digits'),
      callStatus: first(fields, 'CallStatus')?.toLowerCase() ?? null,
      dialStatus: first(fields, 'DialCallStatus')?.toLowerCase() ?? null,
      durationSeconds: seconds(first(fields, 'DialCallDuration') ?? first(fields, 'CallDuration')),
      providerCallId: callSid && CALL_SID.test(callSid) ? callSid : null,
    };
  }

  render(step: CallStep): { contentType: string; body: string } {
    const say = (words: string) => `<Say>${xml(words)}</Say>`;
    switch (step.verb) {
      case 'confirm':
        return twiml(doc(
          `<Gather input="dtmf" numDigits="1" timeout="8" action="${xml(step.next)}" method="POST">${say(step.prompt)}</Gather>`
          + `${say(step.noInput)}<Hangup/>`,
        ));
      case 'dial':
        // [REVIEW-M17 S1-1] The backstop on leg 2: a number the dial guard refuses is never put in a <Dial>.
        if (!dialableNumber(step.to, step.callerId)) return twiml(doc('<Hangup/>'));
        return twiml(doc(
          `${say(step.say)}<Dial callerId="${xml(step.callerId)}" timeout="${step.ringSeconds}" timeLimit="${step.limitSeconds}" ${NEVER_RECORD} action="${xml(step.done)}" method="POST">`
          + `<Number url="${xml(step.screen)}" method="POST">${xml(step.to)}</Number></Dial>`,
        ));
      case 'dialApp':
        // [INAPP-CALLS] <Client><Identity> per app install, <Parameter> for the caller line, url= on answer.
        return twiml(doc(
          `<Dial callerId="${xml(step.callerId)}" timeout="${step.ringSeconds}" timeLimit="${step.limitSeconds}" ${NEVER_RECORD} action="${xml(step.done)}" method="POST">`
          + step.clients.map((identity) => `<Client url="${xml(step.answered)}" method="POST"><Identity>${xml(identity)}</Identity>`
            + Object.entries(step.params).map(([name, value]) => `<Parameter name="${xml(name)}" value="${xml(value)}"/>`).join('')
            + '</Client>').join('')
          + '</Dial>',
        ));
      case 'connect':
        // The screen's document ends here, so Twilio connects the two parties.
        return twiml(doc(''));
      case 'hangup':
        return twiml(doc(`${step.say ? say(step.say) : ''}<Hangup/>`));
    }
  }
}

const twiml = (body: string) => ({ contentType: 'text/xml', body });
