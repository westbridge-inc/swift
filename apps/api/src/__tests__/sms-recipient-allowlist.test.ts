import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { getChannels } from '../providers/notifications/channels';
import { assertSafeBootConfig } from '../utils/boot-config';
import { smsRecipientNotAllowlistedCounter } from '../plugins/observability';
import { guyanaDayKey } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [L04 · SMS allowlist] Outside production, a real SMS provider texts ONLY the
// numbers on SMS_RECIPIENT_ALLOWLIST. A test robot tapping "Send code" with a
// random number on staging must never text a stranger. Any other recipient:
// nothing is sent, the caller sees an ordinary send (no oracle), and a counter
// moves — the number itself is never logged. An empty allowlist texts no one.
// Production is unaffected, and production refuses to boot with the setting
// present so it can never quietly restrict real users.
// ---------------------------------------------------------------------------

const ALLOWED = '+5926000101';
const STRANGER = '+5926000102';
const TWILIO_ENV = {
  NOTIFICATION_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'test-key-secret',
  TWILIO_FROM: '+15550000000',
} as const;
const KEYS = [...Object.keys(TWILIO_ENV), 'SMS_RECIPIENT_ALLOWLIST', 'NODE_ENV', 'PUSH_PROVIDER'] as const;
const saved: Record<string, string | undefined> = {};

let fetchCalls: string[] = [];
function stubTwilio() {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    fetchCalls.push(new URLSearchParams(init.body).get('To') ?? '');
    return new Response(JSON.stringify({ sid: `SM${'0'.repeat(32)}` }), { status: 201 });
  }));
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const notAllowlisted = async () => (await smsRecipientNotAllowlistedCounter.get()).values.reduce((n, v) => n + v.value, 0);

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => {
  setEnv(saved);
});

describe('[SMS allowlist] outside production a real provider texts only allowlisted numbers', () => {
  it('a number on the allowlist is texted; any other number is not, the send still "succeeds", and the counter moves', async () => {
    setEnv({ ...TWILIO_ENV, NODE_ENV: 'loadtest', SMS_RECIPIENT_ALLOWLIST: `${ALLOWED}, +5926000199` });
    stubTwilio();
    const logged: string[] = [];
    const sms = getChannels().sms;
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });

    const before = await notAllowlisted();
    await expect(sms.sendSms(ALLOWED, 'hello')).resolves.toMatchObject({ ref: expect.any(String) });
    await expect(sms.sendSms(STRANGER, 'hello')).resolves.toMatchObject({ ref: expect.any(String) });

    expect(fetchCalls).toEqual([ALLOWED]);
    expect(await notAllowlisted()).toBe(before + 1);
    expect(logged.join('\n')).not.toContain(STRANGER);
    expect(logged.join('\n')).not.toContain(STRANGER.slice(-7));
  });

  it('an empty or missing allowlist texts no one (fail closed)', async () => {
    for (const value of [undefined, '', '  ,  ']) {
      setEnv({ ...TWILIO_ENV, NODE_ENV: 'development', SMS_RECIPIENT_ALLOWLIST: value });
      stubTwilio();
      await getChannels().sms.sendSms(ALLOWED, 'hello');
      expect(fetchCalls, `allowlist ${JSON.stringify(value)}`).toEqual([]);
    }
  });

  it('production is unaffected: every recipient is texted', async () => {
    setEnv({ ...TWILIO_ENV, NODE_ENV: 'production', PUSH_PROVIDER: 'expo', SMS_RECIPIENT_ALLOWLIST: undefined });
    stubTwilio();
    await getChannels().sms.sendSms(STRANGER, 'hello');
    expect(fetchCalls).toEqual([STRANGER]);
  });
});

describe('[SMS allowlist] the deployment says what it will do', () => {
  it('logs the allowlist COUNT (never a number), and warns loudly when SMS is off', async () => {
    const lines: Array<{ level: string; text: string }> = [];
    const capture = (level: string) => (...a: unknown[]) => { lines.push({ level, text: a.map(String).join(' ') }); };
    vi.spyOn(console, 'info').mockImplementation(capture('info'));
    vi.spyOn(console, 'warn').mockImplementation(capture('warn'));

    setEnv({ ...TWILIO_ENV, NODE_ENV: 'loadtest', SMS_RECIPIENT_ALLOWLIST: `${ALLOWED},+5926000199,+5926000198` });
    getChannels();
    expect(lines.some((l) => l.level === 'info' && /3 allowlisted recipient/.test(l.text))).toBe(true);

    setEnv({ SMS_RECIPIENT_ALLOWLIST: undefined });
    getChannels();
    expect(lines.some((l) => l.level === 'warn' && /SMS is OFF: no allowlisted recipients/.test(l.text))).toBe(true);

    const all = lines.map((l) => l.text).join('\n');
    for (const n of [ALLOWED, '+5926000199', '+5926000198']) expect(all).not.toContain(n.slice(-7));
  });
});

describe('[SMS allowlist] the boot check', () => {
  it('production refuses to start while the allowlist setting is present', () => {
    const prod = { NODE_ENV: 'production' };
    // Control: without the setting, production fails for some OTHER missing
    // configuration — the allowlist refusal below is its own check.
    expect(() => assertSafeBootConfig(prod)).toThrow();
    expect(() => assertSafeBootConfig(prod)).not.toThrow(/SMS_RECIPIENT_ALLOWLIST/);
    expect(() => assertSafeBootConfig({ ...prod, SMS_RECIPIENT_ALLOWLIST: ALLOWED })).toThrow(/SMS_RECIPIENT_ALLOWLIST/);
    expect(() => assertSafeBootConfig({ ...prod, SMS_RECIPIENT_ALLOWLIST: '' })).toThrow(/SMS_RECIPIENT_ALLOWLIST/);
    expect(() => assertSafeBootConfig({ ...prod, SMS_RECIPIENT_ALLOWLIST_FILE: '/run/secrets/SMS_RECIPIENT_ALLOWLIST' })).toThrow(/SMS_RECIPIENT_ALLOWLIST/);
  });

  it('outside production a malformed entry is refused loudly rather than silently texting no one', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', SMS_RECIPIENT_ALLOWLIST: `${ALLOWED},5926000103` })).toThrow(/SMS_RECIPIENT_ALLOWLIST/);
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', SMS_RECIPIENT_ALLOWLIST: `${ALLOWED}, +5926000199` })).not.toThrow(/SMS_RECIPIENT_ALLOWLIST/);
  });
});

describe('[SMS allowlist] send-otp gives no oracle', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    setEnv({ ...TWILIO_ENV, NODE_ENV: 'test', SMS_RECIPIENT_ALLOWLIST: ALLOWED });
    const { prismaPlugin } = await import('../plugins/prisma');
    const { redisPlugin } = await import('../plugins/redis');
    const { authPlugin } = await import('../plugins/auth');
    const { socketPlugin } = await import('../plugins/socket');
    const { registerErrorHandler } = await import('../middleware/error-handler');
    const { authRoutes } = await import('../modules/auth/auth.routes');
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.register(authRoutes, { prefix: '/api/v1/auth' });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('an allowlisted and a non-allowlisted number get the same answer; only the first is texted', async () => {
    const day = guyanaDayKey(new Date());
    const answers = [];
    stubTwilio();
    for (const phone of [ALLOWED, STRANGER]) {
      await app.redis.del(`otp_rate:${phone}`, `otp_hr:${phone}`, `otp_phone_day:${day}:${phone}`, `sms_global_day:${day}`, `otp_ip_day:${day}:127.0.0.1`);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/send-otp', payload: { phone }, headers: { 'content-type': 'application/json' } });
      answers.push({ status: res.statusCode, body: res.body });
    }
    expect(answers[0]!.status).toBe(200);
    expect(answers[1]).toEqual(answers[0]);
    expect(fetchCalls).toEqual([ALLOWED]);
  });
});
