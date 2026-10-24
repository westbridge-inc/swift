import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider, type NotificationHandoff, type PushOptions, type PushProvider } from '../providers/notifications/channels';
import {
  ALERT_CLASS_KINDS,
  JOB_OFFERS_CHANNEL,
  JOB_RING_SOUND,
  RINGER_ALERTS_VERSION,
  pushOptionsFor,
  pushOptionsForDevice,
} from '../providers/notifications/alert-class';
import { pushToDevices } from '../providers/notifications/device-push';

// ---------------------------------------------------------------------------
// [RINGER · loud alerts 3/4] The job ring on the wire (owner ruling 15 Oct).
//
// A new store order (ring_order) or a mover's offer (ring_offer) rings with
// Swift's own tone on the 'job_offers' Android channel and breaks through an
// iOS Focus as time-sensitive, but ONLY on a phone whose app reported it has
// all three (DeviceToken.alertsVersion >= 1, app build 12). Builds 9-11 have
// only the "default" channel, no bundled tone and no entitlement: they must
// keep receiving byte-for-byte the message they get today, or a missing
// channel or sound could cost a store its order alert.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-10-15T18:00:00.000Z');
const iso = (msFromT0: number) => new Date(T0 + msFromT0).toISOString();

function okFetch() {
  return vi.fn(async (_url: string, init: { body: string }) => ({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ data: (JSON.parse(init.body) as unknown[]).map(() => ({ status: 'ok' })) }),
  }));
}
type FetchMock = ReturnType<typeof okFetch>;
const messagesOf = (fetchMock: FetchMock, call: number) =>
  JSON.parse((fetchMock.mock.calls[call] as unknown as [string, { body: string }])[1].body) as Array<Record<string, unknown>>;

function atT0() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const RINGING_KINDS = [...ALERT_CLASS_KINDS.ring_order, ...ALERT_CLASS_KINDS.ring_offer];
const QUIET_OR_LOUD_KINDS = [
  ...ALERT_CLASS_KINDS.job_update,
  ...ALERT_CLASS_KINDS.standard,
  ...ALERT_CLASS_KINDS.quiet,
  'a_kind_nobody_listed',
];
const payload = (kind: string) => ({ kind, orderId: 'o1', respondBy: iso(60_000), expiresAt: iso(20_000) });

describe('pushOptionsForDevice: the ring only for an app that has it', () => {
  it('a ringing push to the ring build adds the job_offers channel, the bundled tone and time-sensitive', () => {
    expect(RINGER_ALERTS_VERSION).toBe(1);
    expect(RINGING_KINDS).toEqual(expect.arrayContaining(['vendor_order_alert', 'booking_requested', 'dispatch_offer']));
    for (const kind of RINGING_KINDS) {
      for (const alertsVersion of [1, 2]) {
        expect(pushOptionsForDevice(payload(kind), alertsVersion), kind).toEqual({
          ...pushOptionsFor(payload(kind)),
          sound: 'swift_job_ring.wav',
          channelId: 'job_offers',
          interruptionLevel: 'time-sensitive',
        });
      }
    }
    expect(JOB_OFFERS_CHANNEL).toBe('job_offers');
    expect(JOB_RING_SOUND).toBe('swift_job_ring.wav');
  });

  it('builds 9-11, and anything that is not a whole number >= 1, get exactly today\'s options', () => {
    for (const kind of RINGING_KINDS) {
      for (const alertsVersion of [0, -1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', true, null, undefined, {}]) {
        expect(pushOptionsForDevice(payload(kind), alertsVersion), `${kind} @ ${String(alertsVersion)}`).toEqual(pushOptionsFor(payload(kind)));
      }
    }
  });

  it('a push that does not ring never names the channel, the tone or time-sensitive, on any build', () => {
    for (const kind of QUIET_OR_LOUD_KINDS) {
      expect(pushOptionsForDevice(payload(kind), 1), kind).toEqual(pushOptionsFor(payload(kind)));
    }
    expect(pushOptionsForDevice(undefined, 1)).toEqual(pushOptionsFor(undefined));
  });
});

describe('the exact Expo message, per build', () => {
  it('ring build: today\'s message plus channelId, the tone file and interruptionLevel', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const data = { kind: 'dispatch_offer', orderId: 'o1', offerAttemptId: 'a1', expiresAt: iso(19_500) };
    await new ExpoPushProvider().sendPush(['ExponentPushToken[ring]'], 'T', 'B', data, pushOptionsForDevice(data, 1));
    expect(messagesOf(fetchMock, 0)).toEqual([{
      to: 'ExponentPushToken[ring]', title: 'T', body: 'B', data,
      priority: 'high', sound: 'swift_job_ring.wav', channelId: 'job_offers', interruptionLevel: 'time-sensitive', ttl: 19,
    }]);
  });
});

describe('pushToDevices: one push, each device told only what its app can ring with', () => {
  const OLD_A = 'ExponentPushToken[build-11-a]';
  const NEW_B = 'ExponentPushToken[build-12-b]';
  const OLD_C = 'ExponentPushToken[build-9-c]';
  const devices = [
    { token: OLD_A, alertsVersion: 0 },
    { token: NEW_B, alertsVersion: 1 },
    { token: OLD_C, alertsVersion: undefined },
  ];

  it('a new order goes out as two requests: builds 9-11 exactly as today, the ring build with the ring', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const data = { kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 'SW-1', status: 'PENDING', audience: 'business', respondBy: iso(600_000) };
    const result = await pushToDevices(new ExpoPushProvider(), devices, 'T', 'B', data);
    expect(result).toEqual({ sent: 3, invalidTokens: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const today = { title: 'T', body: 'B', data, priority: 'high', sound: 'default', ttl: 600 };
    expect(messagesOf(fetchMock, 0)).toEqual([{ to: OLD_A, ...today }, { to: OLD_C, ...today }]);
    expect(messagesOf(fetchMock, 1)).toEqual([
      { to: NEW_B, ...today, sound: 'swift_job_ring.wav', channelId: 'job_offers', interruptionLevel: 'time-sensitive' },
    ]);
  });

  it('a push that does not ring is ONE request with today\'s message for every device', async () => {
    atT0();
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    const data = { orderId: 'o1', orderNumber: 'SW-1', status: 'ACCEPTED' };
    expect(await pushToDevices(new ExpoPushProvider(), devices, 'T', 'B', data)).toEqual({ sent: 3, invalidTokens: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(messagesOf(fetchMock, 0)).toEqual([OLD_A, NEW_B, OLD_C].map((to) => ({ to, title: 'T', body: 'B', data, priority: 'high', sound: 'default' })));
  });

  it('a failure in one group never costs the other group its alert, and is still reported', async () => {
    const calls: Array<{ tokens: string[]; options?: PushOptions }> = [];
    const flaky: PushProvider = {
      async sendPush(tokens, _title, _body, _data, options) {
        calls.push({ tokens, options });
        if (calls.length === 1) throw new Error('provider down');
        return { sent: tokens.length, invalidTokens: ['dead'] };
      },
    };
    const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await expect(pushToDevices(flaky, devices, 'T', 'B', data)).rejects.toThrow('provider down');
    expect(calls.map((call) => call.tokens)).toEqual([[OLD_A, OLD_C], [NEW_B]]);
    expect(calls[1]!.options?.channelId).toBe('job_offers');
  });

  it('a handoff keeps today\'s part names for builds 9-11 and gives the ring group its own', async () => {
    const parts: string[] = [];
    const handoff: NotificationHandoff = async (part, effect) => {
      parts.push(part);
      return effect();
    };
    const recording: PushProvider = {
      supportsHandoff: true,
      async sendPush(tokens, _title, _body, _data, options) {
        await options?.handoff?.('chunk:0', async () => undefined);
        return { sent: tokens.length };
      },
    };
    const data = { kind: 'dispatch_offer', orderId: 'o1', expiresAt: new Date(Date.now() + 20_000).toISOString() };
    await pushToDevices(recording, devices, 'T', 'B', data, { handoff });
    expect(parts).toEqual(['chunk:0', 'ring:chunk:0']);
  });

  it('no devices, no request', async () => {
    const sendPush = vi.fn();
    expect(await pushToDevices({ sendPush }, [], 'T', 'B', { kind: 'dispatch_offer' })).toEqual({ sent: 0, invalidTokens: [] });
    expect(sendPush).not.toHaveBeenCalled();
  });
});
