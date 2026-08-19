import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExpoPushProvider,
  getPushProvider,
  getChannels,
  devChannelLog,
  resetDevChannelLog,
} from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// Push delivery — provider seam (hard rule 4). Failure paths first: dead
// tokens must surface as invalidTokens (so the service can deactivate them),
// HTTP failure must throw (callers already .catch), selection is config.
// ---------------------------------------------------------------------------

/** Fetch stub in the payment-provider test's style: only what the adapter reads. */
function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }));
}

afterEach(() => {
  delete process.env['PUSH_PROVIDER'];
  delete process.env['PUSH_PROVIDER_TIMEOUT_MS'];
  vi.unstubAllGlobals();
  resetDevChannelLog();
});

describe('getPushProvider', () => {
  it('defaults to the dev adapter (logs, sends nothing)', async () => {
    const push = getPushProvider();
    await push.sendPush(['tok1', 'tok2'], 'Hi', 'Body');
    expect(devChannelLog.filter((e) => e.channel === 'push')).toHaveLength(2);
  });

  it('builds ExpoPushProvider when configured, throws on unknown', () => {
    process.env['PUSH_PROVIDER'] = 'expo';
    expect(getPushProvider()).toBeInstanceOf(ExpoPushProvider);
    process.env['PUSH_PROVIDER'] = 'nope';
    expect(() => getPushProvider()).toThrow(/Unknown PUSH_PROVIDER/);
  });

  it('composes into getChannels for both sms provider bundles', () => {
    process.env['PUSH_PROVIDER'] = 'expo';
    // getChannels wraps push in withPushRetry [SWIFT-UG-NOTIF-01] — the
    // selected provider sits behind the wrapper's `inner`.
    expect((getChannels().push as { inner?: unknown }).inner).toBeInstanceOf(ExpoPushProvider);
  });
});

describe('ExpoPushProvider', () => {
  it('counts ok tickets and surfaces DeviceNotRegistered tokens by position', async () => {
    const fetchMock = mockFetch(200, {
      data: [
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await new ExpoPushProvider().sendPush(['alive1', 'dead', 'alive2'], 'T', 'B', { k: 1 });

    expect(res.sent).toBe(2);
    expect(res.invalidTokens).toEqual(['dead']);
    // One chunk, message shape Expo expects
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({ to: 'alive1', title: 'T', body: 'B', data: { k: 1 } });
  });

  it('chunks requests at 100 messages', async () => {
    const fetchMock = mockFetch(200, { data: Array.from({ length: 100 }, () => ({ status: 'ok' })) });
    vi.stubGlobal('fetch', fetchMock);

    const tokens = Array.from({ length: 150 }, (_, i) => `tok${i}`);
    await new ExpoPushProvider().sendPush(tokens, 'T', 'B');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body);
    expect(second).toHaveLength(50);
  });

  it('throws on non-2xx so the caller-side catch owns the failure', async () => {
    vi.stubGlobal('fetch', mockFetch(429, { errors: [{ code: 'RATE_LIMIT' }] }));
    await expect(new ExpoPushProvider().sendPush(['tok'], 'T', 'B')).rejects.toThrow(/Expo push failed \(429\)/);
  });

  it('aborts a hung provider request within the configured deadline', async () => {
    process.env['PUSH_PROVIDER_TIMEOUT_MS'] = '20';
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal | null }) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }));

    const startedAt = Date.now();
    await expect(new ExpoPushProvider().sendPush(['tok'], 'T', 'B'))
      .rejects.toThrow(/Expo push request failed: timed out after 20ms/);
    expect(observedSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('omits invalidTokens when every ticket is ok', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { data: [{ status: 'ok' }] }));
    const res = await new ExpoPushProvider().sendPush(['tok'], 'T', 'B');
    expect(res).toEqual({ sent: 1 });
  });
});
