import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExpoPushProvider,
  devChannelLog,
  expoReceiptCheckDelayMs,
  getPushProvider,
  resetDevChannelLog,
  withPushRetry,
  type PushProvider,
} from '../providers/notifications/channels';
import { ALERT_CLASS_KINDS, pushOptionsFor } from '../providers/notifications/alert-class';
import { pushFailuresCounter } from '../plugins/observability';
import { setAppLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 1/4] What actually leaves for Expo, per alert class.
//
// Before this, every message was { to, title, body, data, sound } whatever it
// carried: no priority (Android's default is normal, so a dozing phone held a
// new order or a 20 s offer until its next maintenance window) and no expiry
// (an offer could be delivered long after it died). These cases stub fetch
// and read the exact JSON, because the wire is the contract: Expo rejects a
// request it cannot validate, so an extra field is not harmless either.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-24T20:00:00.000Z');
const iso = (msFromT0: number) => new Date(T0 + msFromT0).toISOString();
const TOKEN = 'ExponentPushToken[q10-wire]';

type FetchMock = ReturnType<typeof okFetch>;

/** Accepts every message: one ok ticket per message sent. */
function okFetch() {
  return vi.fn(async (_url: string, init: { body: string }) => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ data: (JSON.parse(init.body) as unknown[]).map(() => ({ status: 'ok' })) }),
  }));
}

const messagesOf = (fetchMock: FetchMock, call = 0) =>
  JSON.parse((fetchMock.mock.calls[call] as unknown as [string, { body: string }])[1].body) as Array<Record<string, unknown>>;

/** Freeze the clock at T0 (Date only: the adapter timeout stays real). */
function atT0() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
}

async function wire(data: Record<string, unknown>) {
  const fetchMock = okFetch();
  vi.stubGlobal('fetch', fetchMock);
  await new ExpoPushProvider().sendPush([TOKEN], 'T', 'B', data, pushOptionsFor(data));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return messagesOf(fetchMock);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetDevChannelLog();
  delete process.env['PUSH_PROVIDER'];
});

describe('the exact Expo message each alert class sends', () => {
  it('ring_order: high priority, the device sound, a ttl that ends at respondBy', async () => {
    atT0();
    const data = { kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 'SW-1', status: 'PENDING', audience: 'business', respondBy: iso(600_000) };
    expect(await wire(data)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data, priority: 'high', sound: 'default', ttl: 600 },
    ]);
  });

  it('ring_offer: high priority, the device sound, a ttl of the whole seconds left on the offer', async () => {
    atT0();
    // 19.5 s left: rounded DOWN, so even a provider holding it the full ttl
    // lets it die before the offer does.
    const data = { kind: 'dispatch_offer', orderId: 'o1', offerAttemptId: 'a1', expiresAt: iso(19_500) };
    expect(await wire(data)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data, priority: 'high', sound: 'default', ttl: 19 },
    ]);
  });

  it('job_update: high priority, the device sound, an hour at most and never past respondBy', async () => {
    atT0();
    const ready = { kind: 'prep_ready', orderId: 'o1', audience: 'earner' };
    expect(await wire(ready)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data: ready, priority: 'high', sound: 'default', ttl: 3600 },
    ]);
    const selfie = { kind: 'liveness_midshift_prompt', respondBy: iso(300_000), profile: 'DRIVER' };
    expect(await wire(selfie)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data: selfie, priority: 'high', sound: 'default', ttl: 300 },
    ]);
  });

  it('standard: high priority, the device sound, the provider default ttl', async () => {
    atT0();
    const data = { orderId: 'o1', orderNumber: 'SW-1', status: 'ACCEPTED' };
    expect(await wire(data)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data, priority: 'high', sound: 'default' },
    ]);
  });

  it('quiet: normal priority, no sound, a day', async () => {
    atT0();
    const data = { kind: 'RATING_REMINDER', orderId: 'o1' };
    expect(await wire(data)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data, priority: 'normal', ttl: 86_400 },
    ]);
  });

  it('a caller that passes no options gets the standard class', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await new ExpoPushProvider().sendPush([TOKEN], 'T', 'B', { orderId: 'o1' });
    expect(messagesOf(fetchMock)).toEqual([
      { to: TOKEN, title: 'T', body: 'B', data: { orderId: 'o1' }, priority: 'high', sound: 'default' },
    ]);
  });

  it('no message of any class carries channelId (old builds only have the default channel), or any field Expo does not document', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const kinds = Object.values(ALERT_CLASS_KINDS).flat();
    const provider = new ExpoPushProvider();
    for (const kind of kinds) {
      const data = { kind, orderId: 'o1', respondBy: iso(60_000), expiresAt: iso(60_000) };
      await provider.sendPush([TOKEN], 'T', 'B', data, pushOptionsFor(data));
    }
    const messages = fetchMock.mock.calls.flatMap((_call, i) => messagesOf(fetchMock, i));
    expect(messages).toHaveLength(kinds.length);
    for (const message of messages) {
      expect(message).not.toHaveProperty('channelId');
      expect(message).not.toHaveProperty('interruptionLevel');
      for (const field of Object.keys(message)) {
        expect(['to', 'title', 'body', 'data', 'priority', 'sound', 'ttl'], `${String((message['data'] as { kind?: string }).kind)} sent ${field}`).toContain(field);
      }
    }
  });
});

describe('a push never outlives its deadline', () => {
  it('an offer with less than a whole second left, or already expired, is not sent at all', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    for (const expiresAt of [iso(999), iso(0), iso(-5_000)]) {
      const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt };
      expect(await new ExpoPushProvider().sendPush([TOKEN], 'T', 'B', data, pushOptionsFor(data))).toEqual({ sent: 0 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed offer push is never retried past the offer deadline', async () => {
    // Production delays (2 s, then 8 s) against an offer with 1.5 s left:
    // the first retry would wake after the offer died, so there is none.
    let attempts = 0;
    const failing: PushProvider = {
      async sendPush() {
        attempts += 1;
        throw new Error('relay 503');
      },
    };
    const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt: new Date(Date.now() + 1_500).toISOString() };
    const started = Date.now();
    await expect(withPushRetry(failing).sendPush([TOKEN], 'T', 'B', data, pushOptionsFor(data))).rejects.toThrow('relay 503');
    expect(attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a retry that fits inside the window still happens, and asks for the time that is left', async () => {
    atT0();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        // The relay fails, and a second and a half passes before the retry.
        vi.setSystemTime(T0 + 1_500);
        return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
      })
      .mockImplementation(async (_url: string, init: { body: string }) => ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ data: (JSON.parse(init.body) as unknown[]).map(() => ({ status: 'ok' })) }),
      }));
    vi.stubGlobal('fetch', fetchMock);
    const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt: iso(5_000) };
    const res = await withPushRetry(new ExpoPushProvider(), [1]).sendPush([TOKEN], 'T', 'B', data, pushOptionsFor(data));
    expect(res).toEqual({ sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ttls = [0, 1].map((call) => messagesOf(fetchMock as unknown as FetchMock, call)[0]!['ttl']);
    expect(ttls).toEqual([5, 3]);
  });

  it('a push without a deadline keeps the full retry ladder', async () => {
    let attempts = 0;
    const flaky: PushProvider = {
      async sendPush() {
        attempts += 1;
        if (attempts < 3) throw new Error(`transient ${attempts}`);
        return { sent: 1 };
      },
    };
    const data = { kind: 'prep_ready', orderId: 'o1' };
    expect(await withPushRetry(flaky, [1, 1]).sendPush([TOKEN], 'T', 'B', data, pushOptionsFor(data))).toEqual({ sent: 1 });
    expect(attempts).toBe(3);
  });
});

describe('the dev adapter logs what would have been sent', () => {
  it('records each push with its delivery options', async () => {
    atT0();
    const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt: iso(20_000) };
    await getPushProvider().sendPush(['a', 'b'], 'T', 'B', data, pushOptionsFor(data));
    const options = { alertClass: 'ring_offer', priority: 'high', sound: 'default', deadlineMs: T0 + 20_000 };
    expect(devChannelLog.map((e) => ({ to: e.to, options: e.options }))).toEqual([{ to: 'a', options }, { to: 'b', options }]);
  });

  it('drops a push whose deadline passed, as the Expo adapter does', async () => {
    atT0();
    const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt: iso(-1) };
    expect(await getPushProvider().sendPush(['a'], 'T', 'B', data, pushOptionsFor(data))).toEqual({ sent: 0 });
    expect(devChannelLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// [STORE-ALERT 18 Oct 2026] A push that does not reach a phone leaves a
// structured log line and a count, by error CLASS only — never the token.
// Before this, every refused ticket except DeviceNotRegistered vanished, a
// receipt was never read (InvalidCredentials, the app's push key, only shows
// there) and a failed request was counted by nobody.
// ---------------------------------------------------------------------------
describe('[STORE-ALERT] push failures are logged and counted by class, never by token', () => {
  type Line = { level: string; obj: Record<string, unknown>; msg: string };
  let lines: Line[] = [];
  const capture = {
    info: (obj: Record<string, unknown>, msg: string) => { lines.push({ level: 'info', obj, msg }); },
    warn: (obj: Record<string, unknown>, msg: string) => { lines.push({ level: 'warn', obj, msg }); },
    error: (obj: Record<string, unknown>, msg: string) => { lines.push({ level: 'error', obj, msg }); },
    debug: () => {},
  };
  const failures = async () => Object.fromEntries((await pushFailuresCounter.get()).values
    .map((v) => [`${v.labels['stage']}:${v.labels['reason']}`, v.value]));
  const tokens = ['ExponentPushToken[sa-a]', 'ExponentPushToken[sa-b]', 'ExponentPushToken[sa-c]', 'ExponentPushToken[sa-d]'];

  beforeEach(() => {
    lines = [];
    pushFailuresCounter.reset();
    setAppLogger(capture as never);
  });
  afterEach(() => { setAppLogger(console); });

  it('refused tickets: one count per class (unknown -> other), only DeviceNotRegistered retires a token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ data: [
        { status: 'error', details: { error: 'InvalidCredentials' } },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'SomethingNew' } },
        { status: 'ok', id: 'r-1' },
      ] }),
    })));
    const result = await new ExpoPushProvider().sendPush(tokens, 'New Order!', 'B', { kind: 'vendor_order_alert' });
    expect(result).toEqual({ sent: 1, invalidTokens: [tokens[1]] });
    expect(await failures()).toEqual({ 'ticket:InvalidCredentials': 1, 'ticket:DeviceNotRegistered': 1, 'ticket:other': 1 });
    expect(lines.filter((l) => l.obj['event'] === 'push_failure').map((l) => l.obj)).toEqual([
      { event: 'push_failure', stage: 'ticket', reason: 'InvalidCredentials', count: 1, kind: 'vendor_order_alert' },
      { event: 'push_failure', stage: 'ticket', reason: 'DeviceNotRegistered', count: 1, kind: 'vendor_order_alert' },
      { event: 'push_failure', stage: 'ticket', reason: 'other', count: 1, kind: 'vendor_order_alert' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('ExponentPushToken');
  });

  it('a failed request is counted by what went wrong (HTTP class, network, timeout, a short ticket list)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down', json: async () => ({}) })));
    await expect(new ExpoPushProvider().sendPush(tokens.slice(0, 2), 'T', 'B', { kind: 'dispatch_offer' })).rejects.toThrow('503');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => '', json: async () => ({}) })));
    await expect(new ExpoPushProvider().sendPush(tokens.slice(0, 1), 'T', 'B', {})).rejects.toThrow('429');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(new ExpoPushProvider().sendPush(tokens.slice(0, 1), 'T', 'B', {})).rejects.toThrow('ECONNRESET');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ status: 'ok' }] }) })));
    await new ExpoPushProvider().sendPush(tokens.slice(0, 3), 'T', 'B', {});
    process.env['PUSH_PROVIDER_TIMEOUT_MS'] = '20';
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
      await expect(new ExpoPushProvider().sendPush(tokens.slice(0, 1), 'T', 'B', {})).rejects.toThrow('timed out');
    } finally {
      delete process.env['PUSH_PROVIDER_TIMEOUT_MS'];
    }
    expect(await failures()).toEqual({
      'request:http_5xx': 2, 'request:http_429': 1, 'request:network': 1, 'request:bad_response': 2, 'request:timeout': 1,
    });
    expect(JSON.stringify(lines)).not.toContain('ExponentPushToken');
  });

  it('receipts: every error class is counted; ids Expo does not know yet are skipped', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ data: {
        'r-1': { status: 'ok' },
        'r-2': { status: 'error', details: { error: 'InvalidCredentials' } },
        'r-3': { status: 'error', details: { error: 'InvalidCredentials' } },
        'r-4': { status: 'error', details: { error: 'MessageRateExceeded' } },
      } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await new ExpoPushProvider().checkReceipts(['r-1', 'r-2', 'r-3', 'r-4', 'r-not-ready'], { kind: 'vendor_order_alert' });
    expect(outcome).toEqual({ ok: 1, failed: ['InvalidCredentials', 'InvalidCredentials', 'MessageRateExceeded'] });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ ids: ['r-1', 'r-2', 'r-3', 'r-4', 'r-not-ready'] });
    expect(await failures()).toEqual({ 'receipt:InvalidCredentials': 2, 'receipt:MessageRateExceeded': 1 });
  });

  it('the production adapter reads the receipts of accepted tickets after the configured delay', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/getReceipts')
      ? { ok: true, status: 200, text: async () => '', json: async () => ({ data: { 'r-9': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }) }
      : { ok: true, status: 200, text: async () => '', json: async () => ({ data: [{ status: 'ok', id: 'r-9' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await new ExpoPushProvider({ receiptCheckDelayMs: 5 }).sendPush(tokens.slice(0, 1), 'T', 'B', { kind: 'vendor_order_alert' });
    await vi.waitFor(async () => expect(await failures()).toEqual({ 'receipt:DeviceNotRegistered': 1 }));
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0].split('/').at(-1))).toEqual(['send', 'getReceipts']);
  });

  it('receipts are on by default for PUSH_PROVIDER=expo and can be turned off', () => {
    delete process.env['EXPO_PUSH_RECEIPT_DELAY_MS'];
    expect(expoReceiptCheckDelayMs()).toBe(60_000);
    process.env['EXPO_PUSH_RECEIPT_DELAY_MS'] = '0';
    try {
      expect(expoReceiptCheckDelayMs()).toBeNull();
    } finally {
      delete process.env['EXPO_PUSH_RECEIPT_DELAY_MS'];
    }
  });
});
