import { describe, it, expect } from 'vitest';
import { TwilioVoiceProvider } from '../providers/voice/twilio-voice';
import { twilioSignature } from '../modules/notification/sms-inbound.routes';
import {
  assertCallRelayConfig,
  CALL_RELAY_DEFAULT_MAX_ATTEMPTS,
  CALL_RING_SECONDS,
  CALL_TIME_LIMIT_SECONDS,
  readCallRelayConfig,
} from '../modules/calls/call-relay-switch';
import { CALL_WORDS, handleVoiceStep, pairAllowed, roleWords } from '../modules/calls/call-bridge';
import { assertSafeBootConfig } from '../utils/boot-config';
import { SECRET_FILE_NAMES } from '../utils/secret-files';
import { PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { testPhone } from './helpers/fixture-ids';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallStep } from '../providers/voice/call-provider';

/** fetch's own init type (the DOM name is not a lint global here). */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

// ---------------------------------------------------------------------------
// [O-1] The call bridge's pure parts: the documents Twilio runs, the request
// that places a call, the signature, the settings, the boot guard, and which
// party may call which. The routes and the database are in call-bridge.test.ts.
// ---------------------------------------------------------------------------

const TOKEN = 'unit-test-webhook-token';
const SID = `AC${'a'.repeat(32)}`;
const KEY = `SK${'b'.repeat(32)}`;
const twilio = (http?: typeof fetch) => new TwilioVoiceProvider({ accountSid: SID, apiKeySid: KEY, apiKeySecret: 'unit-secret', authToken: TOKEN }, http);
const CALLER_ID = '+15005550006';
const BASE = 'https://api.example.test/api/v1/calls/voice';
const full = (over: Record<string, string | undefined> = {}) => ({
  CALL_RELAY: '1', CALL_RELAY_CALLER_ID: CALLER_ID, CALL_RELAY_WEBHOOK_BASE: BASE,
  TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: 'unit-secret', TWILIO_WEBHOOK_AUTH_TOKEN: TOKEN, ...over,
});

describe('[O-1] the documents Twilio runs', () => {
  it('the dial pins Swift\'s caller ID, never records, caps the call at 30 minutes and screens the called phone', () => {
    const to = testPhone();
    const out = twilio().render({ verb: 'dial', say: CALL_WORDS.connecting, to, callerId: CALLER_ID, screen: `${BASE}/screen?s=c1`, done: `${BASE}/dial-done?s=c1`, ringSeconds: CALL_RING_SECONDS, limitSeconds: CALL_TIME_LIMIT_SECONDS });
    expect(out.contentType).toBe('text/xml');
    const dial = out.body.match(/<Dial [^>]*>/)![0];
    expect(dial).toContain(`callerId="${CALLER_ID}"`);
    expect(dial).toContain('record="do-not-record"');
    expect(dial).toContain('timeLimit="1800"');
    expect(dial).toContain('timeout="25"');
    expect(dial).toContain(`action="${BASE}/dial-done?s=c1"`);
    expect(out.body).toContain(`<Number url="${BASE}/screen?s=c1" method="POST">${to}</Number>`);
    // the number appears once, as the dialled number, and nowhere it could be read aloud
    expect(out.body.split(to).length - 1).toBe(1);
    expect(CALL_TIME_LIMIT_SECONDS).toBe(1800);
  });

  it('"Press 1" is a one-key touch-tone gather; silence or another key ends the call', () => {
    const out = twilio().render({ verb: 'confirm', prompt: CALL_WORDS.calleePrompt, next: `${BASE}/screen-gather?s=c1`, noInput: CALL_WORDS.noKey });
    expect(out.body).toMatch(/<Gather input="dtmf" numDigits="1" timeout="8" action="[^"]+screen-gather\?s=c1" method="POST"><Say>Swift call about your order\. Press 1 to connect\.<\/Say><\/Gather>/);
    expect(out.body).toMatch(/<\/Gather><Say>No key was pressed\. Goodbye\.<\/Say><Hangup\/><\/Response>$/);
  });

  it('connecting is an empty document (the screen ends, Twilio connects); a hang-up says its words first', () => {
    expect(twilio().render({ verb: 'connect' }).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(twilio().render({ verb: 'hangup', say: CALL_WORDS.notReached }).body).toContain("<Say>We couldn't reach them. Try again, or message them in chat.</Say><Hangup/>");
    expect(twilio().render({ verb: 'hangup' }).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it('escapes what it writes into the document', () => {
    const out = twilio().render({ verb: 'confirm', prompt: 'a < b & "c"', next: `${BASE}/x?s=1&t=2`, noInput: 'bye' });
    expect(out.body).toContain('<Say>a &lt; b &amp; &quot;c&quot;</Say>');
    expect(out.body).toContain('action="https://api.example.test/api/v1/calls/voice/x?s=1&amp;t=2"');
  });

  it('the owner\'s words are what people hear', () => {
    expect(CALL_WORDS.calleePrompt).toBe('Swift call about your order. Press 1 to connect.');
    expect(CALL_WORDS.callerPrompt).toMatch(/Press 1 to continue\.$/);
  });
});

describe('[O-1] placing a call', () => {
  it('posts To, From, the answer and status URLs, the ring and time limits, and Record=false; returns the call id', async () => {
    const seen: Array<{ url: string; init: FetchInit }> = [];
    const http = (async (url: string, init: FetchInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ sid: `CA${'c'.repeat(32)}` }), { status: 201 });
    }) as unknown as typeof fetch;
    const to = testPhone();
    const out = await twilio(http).placeCall({ to, callerId: CALLER_ID, answerUrl: `${BASE}/leg1?s=c1`, statusUrl: `${BASE}/status?s=c1`, ringSeconds: 25, limitSeconds: 1800 });
    expect(out.providerCallId).toBe(`CA${'c'.repeat(32)}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    const form = new URLSearchParams(String(seen[0]!.init.body));
    expect(form.get('To')).toBe(to);
    expect(form.get('From')).toBe(CALLER_ID);
    expect(form.get('Url')).toBe(`${BASE}/leg1?s=c1`);
    expect(form.get('StatusCallback')).toBe(`${BASE}/status?s=c1`);
    expect(form.getAll('StatusCallbackEvent')).toEqual(['answered', 'completed']);
    expect(form.get('Timeout')).toBe('25');
    expect(form.get('TimeLimit')).toBe('1800');
    expect(form.get('Record')).toBe('false');
    expect((seen[0]!.init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from(`${KEY}:unit-secret`).toString('base64')}`);
  });

  it('a refusal or a malformed answer is an error that carries no provider text', async () => {
    const to = testPhone();
    const refuse = (async () => new Response(`bad number ${to}`, { status: 400 })) as unknown as typeof fetch;
    await expect(twilio(refuse).placeCall({ to, callerId: CALLER_ID, answerUrl: 'https://x', statusUrl: 'https://y', ringSeconds: 25, limitSeconds: 1800 }))
      .rejects.toThrow(/^Twilio call failed \(400\)$/);
    const junk = (async () => new Response(JSON.stringify({ sid: 'nope' }), { status: 201 })) as unknown as typeof fetch;
    await expect(twilio(junk).placeCall({ to, callerId: CALLER_ID, answerUrl: 'https://x', statusUrl: 'https://y', ringSeconds: 25, limitSeconds: 1800 }))
      .rejects.toThrow('Twilio call response invalid');
    const down = (async () => { throw new Error(`socket closed for ${to}`); }) as unknown as typeof fetch;
    const err = await twilio(down).placeCall({ to, callerId: CALLER_ID, answerUrl: 'https://x', statusUrl: 'https://y', ringSeconds: 25, limitSeconds: 1800 }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Twilio call request failed');
  });
});

describe('[O-1] the webhook signature', () => {
  const url = `${BASE}/leg1-gather?s=c1`;
  const fields = { Digits: ['1'], CallSid: [`CA${'d'.repeat(32)}`] };
  it('accepts exactly what Twilio signs: the full URL and the form', () => {
    expect(twilio().verify({ url, fields, signature: twilioSignature(TOKEN, url, fields) })).toBe(true);
  });
  it('refuses a missing signature, another token, another URL, or a changed field', () => {
    expect(twilio().verify({ url, fields, signature: undefined })).toBe(false);
    expect(twilio().verify({ url, fields, signature: '' })).toBe(false);
    expect(twilio().verify({ url, fields, signature: twilioSignature('other-token', url, fields) })).toBe(false);
    expect(twilio().verify({ url: `${BASE}/leg1-gather?s=c2`, fields, signature: twilioSignature(TOKEN, url, fields) })).toBe(false);
    expect(twilio().verify({ url, fields: { ...fields, Digits: ['2'] }, signature: twilioSignature(TOKEN, url, fields) })).toBe(false);
  });
  it('reads the key pressed, the call status, the seconds and the call id', () => {
    expect(twilio().read({ Digits: ['1'], CallStatus: ['Completed'], DialCallDuration: ['42'], CallSid: [`CA${'e'.repeat(32)}`] }))
      .toEqual({ digits: '1', callStatus: 'completed', dialStatus: null, durationSeconds: 42, providerCallId: `CA${'e'.repeat(32)}` });
    expect(twilio().read({ DialCallStatus: ['no-answer'], CallSid: ['junk'] })).toMatchObject({ dialStatus: 'no-answer', providerCallId: null, durationSeconds: null });
  });
});

describe('[O-1] the settings and the boot guard', () => {
  it('a full configuration reads, with the default attempt cap', () => {
    const read = readCallRelayConfig(full());
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.config).toMatchObject({ callerId: CALLER_ID, webhookBase: BASE, maxAttemptsPerOrder: CALL_RELAY_DEFAULT_MAX_ATTEMPTS });
    expect(CALL_RELAY_DEFAULT_MAX_ATTEMPTS).toBe(6);
  });

  it('names what is missing or malformed, never a value', () => {
    const bad = readCallRelayConfig(full({ CALL_RELAY_CALLER_ID: '0712345', CALL_RELAY_WEBHOOK_BASE: 'http://api.example.test/x/', CALL_RELAY_MAX_ATTEMPTS_PER_ORDER: '99', TWILIO_WEBHOOK_AUTH_TOKEN: ' ' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.join(' ')).toMatch(/CALL_RELAY_CALLER_ID/);
      expect(bad.problems.join(' ')).toMatch(/CALL_RELAY_WEBHOOK_BASE/);
      expect(bad.problems.join(' ')).toMatch(/CALL_RELAY_MAX_ATTEMPTS_PER_ORDER/);
      expect(bad.problems.join(' ')).toMatch(/TWILIO_WEBHOOK_AUTH_TOKEN/);
      expect(bad.problems.join(' ')).not.toContain('0712345');
    }
    for (const base of [`${BASE}/`, `${BASE}?a=1`, 'ftp://x', '']) {
      expect(readCallRelayConfig(full({ CALL_RELAY_WEBHOOK_BASE: base })).ok, base).toBe(false);
    }
    expect(readCallRelayConfig(full({ CALL_RELAY_CALLER_ID: '+5926001234' })).ok, 'a Guyana verified caller ID').toBe(true);
  });

  it('CALL_RELAY=1 half-configured refuses to start in every mode; off, nothing is checked', () => {
    expect(() => assertCallRelayConfig(full({ CALL_RELAY_CALLER_ID: undefined }))).toThrow(/^FATAL: CALL_RELAY=1 but the call bridge is not configured: CALL_RELAY_CALLER_ID/);
    expect(() => assertCallRelayConfig(full())).not.toThrow();
    expect(() => assertCallRelayConfig({ CALL_RELAY: '0' })).not.toThrow();
    expect(() => assertCallRelayConfig({})).not.toThrow();
    // wired into the one boot check (development mode, where it runs before the production gate)
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', ...full({ TWILIO_API_KEY_SID: undefined }) })).toThrow(/CALL_RELAY=1 but the call bridge is not configured/);
  });

  it('Swift\'s caller ID can come from the secret store, and Twilio is the registered voice processor', () => {
    expect(SECRET_FILE_NAMES).toContain('CALL_RELAY_CALLER_ID');
    const entry = PROCESSOR_REGISTER.find((p) => p.ref === 'TWILIO');
    expect(entry?.providerDirs).toContain('voice');
    expect(entry?.service).toMatch(/voice calls/);
  });
});

describe('[O-1] who may ask Swift to call whom', () => {
  it('a taxi: only the passenger and the driver, each the other', () => {
    expect(pairAllowed('customer', 'driver', 'TAXI')).toBe(true);
    expect(pairAllowed('driver', 'customer', 'TAXI')).toBe(true);
    for (const [c, t] of [['customer', 'rider'], ['customer', 'store'], ['driver', 'store'], ['driver', 'recipient'], ['customer', 'customer']] as const) {
      expect(pairAllowed(c, t, 'TAXI'), `${c} -> ${t}`).toBe(false);
    }
  });
  it('a store order: customer, rider and store reach each other; no driver', () => {
    for (const [c, t] of [['customer', 'rider'], ['customer', 'store'], ['rider', 'customer'], ['rider', 'store'], ['store', 'rider'], ['store', 'customer']] as const) {
      expect(pairAllowed(c, t, 'FOOD_DELIVERY'), `${c} -> ${t}`).toBe(true);
    }
    expect(pairAllowed('customer', 'driver', 'FOOD_DELIVERY')).toBe(false);
    expect(pairAllowed('store', 'store', 'FOOD_DELIVERY')).toBe(false);
  });
  it('the parcel recipient is called only by the courier rider', () => {
    expect(pairAllowed('rider', 'recipient', 'COURIER')).toBe(true);
    expect(pairAllowed('customer', 'recipient', 'COURIER')).toBe(false);
    expect(pairAllowed('rider', 'recipient', 'FOOD_DELIVERY')).toBe(false);
  });
  it('role words only', () => {
    expect(roleWords('customer', 'TAXI')).toBe('your passenger');
    expect(roleWords('customer', 'FOOD_DELIVERY')).toBe('your customer');
    expect(roleWords('rider', 'COURIER')).toBe('your rider');
    expect(roleWords('store', 'FOOD_DELIVERY')).toBe('the store');
  });
});

// ---------------------------------------------------------------------------
// [O-1 · owner ruling] A Swift call is NEVER recorded. Not an option, not a
// setting: no code path can ask the provider to record, store or transcribe.
// ---------------------------------------------------------------------------
describe('[O-1] calls are never recorded', () => {
  const RECORDING = /record-from|record="(?!do-not-record")|<Record\b|<Conference\b|recordingStatusCallback|RecordingStatusCallback|transcribe|<Stream\b|<Siprec\b/i;
  const steps: CallStep[] = [
    { verb: 'confirm', prompt: CALL_WORDS.callerPrompt, next: `${BASE}/leg1-gather?s=c1`, noInput: CALL_WORDS.noKey },
    { verb: 'dial', say: CALL_WORDS.connecting, to: testPhone(), callerId: CALLER_ID, screen: `${BASE}/screen?s=c1`, done: `${BASE}/dial-done?s=c1`, ringSeconds: CALL_RING_SECONDS, limitSeconds: CALL_TIME_LIMIT_SECONDS },
    { verb: 'connect' },
    { verb: 'hangup', say: CALL_WORDS.notReached },
  ];

  it('every document Swift can answer with: the one <Dial> says record="do-not-record", and nothing else records', () => {
    for (const step of steps) {
      const body = twilio().render(step).body;
      expect(body, step.verb).not.toMatch(RECORDING);
      const records = [...body.matchAll(/\brecord="([^"]*)"/g)].map((m) => m[1]);
      expect(records, step.verb).toEqual(step.verb === 'dial' ? ['do-not-record'] : []);
    }
  });

  it('placing a call says Record=false and asks for no recording callback', async () => {
    let form = new URLSearchParams();
    const http = (async (_url: string, init: FetchInit) => {
      form = new URLSearchParams(String(init.body));
      return new Response(JSON.stringify({ sid: `CA${'f'.repeat(32)}` }), { status: 201 });
    }) as unknown as typeof fetch;
    await twilio(http).placeCall({ to: testPhone(), callerId: CALLER_ID, answerUrl: `${BASE}/leg1?s=c1`, statusUrl: `${BASE}/status?s=c1`, ringSeconds: 25, limitSeconds: 1800 });
    expect(form.getAll('Record')).toEqual(['false']);
    for (const key of form.keys()) expect(key, key).not.toMatch(/^Recording|Transcri/);
  });

  it('the source: no recording verb, attribute, option or callback anywhere in the bridge, and no record field on a step', () => {
    const src = (dir: string) => readdirSync(join(__dirname, '..', dir)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(__dirname, '..', dir, f), 'utf8'));
    const code = [...src('providers/voice'), ...src('modules/calls')].join('\n');
    expect(code.length).toBeGreaterThan(5000);
    expect(code).not.toMatch(RECORDING);
    // exactly one record attribute in the whole bridge, and it is the literal do-not-record
    expect([...code.matchAll(/\brecord="/g)]).toHaveLength(1);
    expect(code).toContain('record="do-not-record"');
    // Record on the Calls API is the literal 'false', never a variable
    expect([...code.matchAll(/\bRecord: /g)].map((m) => code.slice(m.index!, m.index! + 15))).toEqual(["Record: 'false'"]);
    const provider = readFileSync(join(__dirname, '..', 'providers/voice/call-provider.ts'), 'utf8');
    expect(provider).not.toMatch(/\brecord\??:/i);
  });
});

// [REVIEW-M S4-3] The status callback reads the call, then writes. If the callee's 1 lands in between, the
// write must not turn a connected call into NOT_CONNECTED: the status is in the WHERE, not only in the read.
describe('[O-1] a terminal status callback racing the callee\'s 1', () => {
  it('every write that marks NOT_CONNECTED is conditioned on the call not being CONNECTED', async () => {
    const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const stale = { id: 'ckstaleread000000000000000', status: 'CALLER_CONFIRMED', endedAt: null, orderId: 'o1', callerRole: 'customer', calleeRole: 'rider' };
    const prisma = {
      callSession: {
        findUnique: async () => stale,
        updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => { writes.push(args); return { count: 0 }; },
      },
    } as never;
    const read = readCallRelayConfig(full());
    if (!read.ok) throw new Error('the test configuration is incomplete');
    const deps = { prisma, provider: twilio(), config: read.config, notifications: { send: async () => '' } };
    await handleVoiceStep(deps, 'status', stale.id, { fields: { CallStatus: ['completed'], CallDuration: ['40'] } }, true);
    const marks = writes.filter((w) => w.data['status'] === 'NOT_CONNECTED');
    expect(marks.length).toBeGreaterThan(0);
    for (const w of marks) expect(w.where['status'], JSON.stringify(w.where)).toEqual({ not: 'CONNECTED' });
  });
});
