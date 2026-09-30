import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExpoPushProvider,
  devChannelLog,
  getPushProvider,
  resetDevChannelLog,
  withPushRetry,
  type PushProvider,
} from '../providers/notifications/channels';
import { ALERT_CLASS_KINDS, pushOptionsFor } from '../providers/notifications/alert-class';
import { pushToDevices, type PushDevice } from '../providers/notifications/device-push';

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

describe('[Q10 loud alerts 2/4] one push to stored devices: the channel reaches only the builds that have it', () => {
  const data = { kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 'SW-1', audience: 'business', respondBy: iso(600_000) };

  it('today\'s builds get the message they always got; the channel build gets its class channel, in its own request', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const res = await pushToDevices(new ExpoPushProvider(), [
      { token: 'ExponentPushToken[old-a]', alertsVersion: 0 },
      { token: 'ExponentPushToken[new-b]', alertsVersion: 1 },
      { token: 'ExponentPushToken[old-c]', alertsVersion: 0 },
    ], 'T', 'B', data);
    expect(res).toEqual({ sent: 3, invalidTokens: [], withdrawn: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const base = { title: 'T', body: 'B', data, priority: 'high', sound: 'default', ttl: 600 };
    expect(messagesOf(fetchMock, 0)).toEqual([
      { to: 'ExponentPushToken[old-a]', ...base },
      { to: 'ExponentPushToken[old-c]', ...base },
    ]);
    expect(messagesOf(fetchMock, 1)).toEqual([{ to: 'ExponentPushToken[new-b]', ...base, channelId: 'swift_orders_v1' }]);
  });

  it('asks stillWanted before each request, and stops once the push no longer means anything', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    let asked = 0;
    const res = await pushToDevices(new ExpoPushProvider(), [
      { token: 'ExponentPushToken[old-a]', alertsVersion: 0 },
      { token: 'ExponentPushToken[new-b]', alertsVersion: 1 },
    ], 'T', 'B', data, { stillWanted: async () => { asked += 1; return asked === 1; } });
    expect(res).toEqual({ sent: 1, invalidTokens: [], withdrawn: true });
    expect(asked).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(messagesOf(fetchMock, 0).map((m) => m['to'])).toEqual(['ExponentPushToken[old-a]']);
  });

  it('a device row that reports no alertsVersion gets today\'s message, and is never dropped', async () => {
    // The column is NOT NULL DEFAULT 0, but a partial select or a test double
    // can hand over a row without it. Such a device must still be pushed, as
    // today's builds are: never named a channel it did not report, and never
    // silently left out of both groups.
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const res = await pushToDevices(new ExpoPushProvider(), [
      { token: 'ExponentPushToken[bare-a]' } as unknown as PushDevice,
      { token: 'ExponentPushToken[odd-b]', alertsVersion: Number.NaN },
    ], 'T', 'B', data);
    expect(res).toEqual({ sent: 2, invalidTokens: [], withdrawn: false });
    const base = { title: 'T', body: 'B', data, priority: 'high', sound: 'default', ttl: 600 };
    expect(messagesOf(fetchMock, 0)).toEqual([
      { to: 'ExponentPushToken[bare-a]', ...base },
      { to: 'ExponentPushToken[odd-b]', ...base },
    ]);
  });

  it('a provider failure in one group does not cost the other its push, and is still thrown', async () => {
    const seen: string[][] = [];
    const flaky: PushProvider = {
      async sendPush(tokens) {
        seen.push(tokens);
        if (tokens.includes('ExponentPushToken[old-a]')) throw new Error('relay 503');
        return { sent: tokens.length };
      },
    };
    await expect(pushToDevices(flaky, [
      { token: 'ExponentPushToken[old-a]', alertsVersion: 0 },
      { token: 'ExponentPushToken[new-b]', alertsVersion: 1 },
    ], 'T', 'B', data)).rejects.toThrow('relay 503');
    expect(seen).toEqual([['ExponentPushToken[old-a]'], ['ExponentPushToken[new-b]']]);
  });
});

describe('[Q10 loud alerts 2/4 · AX291 F04] the reason for a push is asked before EVERY provider request', () => {
  const data = { kind: 'vendor_order_alert', orderId: 'o1', respondBy: iso(600_000) };

  it('a retry is not sent once the push stopped meaning anything during the backoff', async () => {
    atT0();
    let wanted = true;
    let attempts = 0;
    const flaky: PushProvider = {
      async sendPush() {
        attempts += 1;
        wanted = false; // the order is answered while the retry waits
        throw new Error('relay 503');
      },
    };
    const res = await withPushRetry(flaky, [1, 1]).sendPush([TOKEN], 'T', 'B', data, { ...pushOptionsFor(data), stillWanted: async () => wanted });
    expect(res).toEqual({ sent: 0, withdrawn: true });
    expect(attempts).toBe(1);
  });

  it('the Expo adapter asks before each chunk: a push answered after the first 100 devices goes no further', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    let asked = 0;
    const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[chunk-${i}]`);
    const res = await new ExpoPushProvider().sendPush(tokens, 'T', 'B', data, { ...pushOptionsFor(data), stillWanted: async () => { asked += 1; return asked === 1; } });
    expect(res).toEqual({ sent: 100, withdrawn: true });
    expect(asked).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(messagesOf(fetchMock)).toHaveLength(100);
  });

  it('the dev adapter logs nothing for a withdrawn push, and never logs the guard itself', async () => {
    atT0();
    expect(await getPushProvider().sendPush(['a'], 'T', 'B', data, { ...pushOptionsFor(data), stillWanted: async () => false })).toEqual({ sent: 0, withdrawn: true });
    expect(devChannelLog).toEqual([]);
    expect(await getPushProvider().sendPush(['b'], 'T', 'B', data, { ...pushOptionsFor(data), stillWanted: async () => true })).toEqual({ sent: 1 });
    expect(devChannelLog.map((e) => e.options)).toEqual([pushOptionsFor(data)]);
  });
});
