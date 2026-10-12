import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider } from '../providers/notifications/channels';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Expo provider whole-request deadline', () => {
  it.each([200, 503])('settles when HTTP %i headers arrive but the body stalls', async (status) => {
    let headersSent = false;
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{');
      headersSent = true;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing stub address');
    vi.stubEnv('EXPO_PUSH_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('PUSH_PROVIDER_TIMEOUT_MS', '100');
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        new ExpoPushProvider().sendPush(['synthetic-token'], 'Test', 'Test')
          .then(() => 'unexpected success', (error: Error) => error.message),
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve('still pending'), 1000); }),
      ]);
      expect(headersSent).toBe(true);
      expect(outcome).toMatch(/Expo push request failed: timed out after 100ms/);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['headers', 'json', 'text'])('settles even when %s ignores abort', async (phase) => {
    vi.useFakeTimers();
    vi.stubEnv('PUSH_PROVIDER_TIMEOUT_MS', '100');
    let signal: AbortSignal | null | undefined;
    const body = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: { signal?: AbortSignal | null }) => {
      signal = init.signal;
      if (phase === 'headers') return new Promise(() => {});
      return Promise.resolve({ ok: phase === 'json', status: phase === 'json' ? 200 : 503, json: body, text: body });
    }));
    let outcome = 'still pending';
    const send = new ExpoPushProvider().sendPush(['synthetic-token'], 'Test', 'Test')
      .then(() => { outcome = 'unexpected success'; }, (error: Error) => { outcome = error.message; });
    await vi.advanceTimersByTimeAsync(100);
    if (phase !== 'headers') expect(body).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(outcome).toMatch(/Expo push request failed: timed out after 100ms/);
    await send;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not submit later chunks after a body deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PUSH_PROVIDER_TIMEOUT_MS', '100');
    const fetchStub = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetchStub);
    const failure = new ExpoPushProvider().sendPush(Array.from({ length: 101 }, (_, i) => `synthetic-${i}`), 'T', 'B')
      .catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failure).toMatch(/timed out after 100ms/);
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'http error', 'invalid body', 'network error'])('clears the deadline after %s', async (outcome) => {
    vi.useFakeTimers();
    const fetchStub = vi.fn();
    if (outcome === 'network error') fetchStub.mockRejectedValue(new Error('synthetic network error'));
    else fetchStub.mockResolvedValue({
      ok: outcome !== 'http error', status: 503, text: async () => 'unavailable',
      json: async () => {
        if (outcome === 'invalid body') throw new SyntaxError('invalid synthetic body');
        return { data: [{ status: 'ok' }] };
      },
    });
    vi.stubGlobal('fetch', fetchStub);
    const send = new ExpoPushProvider().sendPush(['synthetic-token'], 'T', 'B');
    if (outcome === 'success') await expect(send).resolves.toEqual({ sent: 1 });
    else await expect(send).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

});
