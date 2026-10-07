import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getChannels } from '../providers/notifications/channels';

// The ops page and the safety escalation send SMS through this adapter. A
// provider that answers with headers and then stalls, or an HTTP stack that
// ignores its abort signal, must still settle the send as failed within the
// eight-second bound, so the page can move on to the next recipient and the
// escalation ladder.

const accountSid = `AC${'a'.repeat(32)}`;

// Outside production the real adapter texts only allowlisted numbers
// (sms-recipient-allowlist.ts). This suite tests the adapter's deadline, so it
// lists the number it texts.
const RECIPIENT = '+5926000000';

function configure() {
  vi.stubEnv('SMS_RECIPIENT_ALLOWLIST', RECIPIENT);
  vi.stubEnv('NOTIFICATION_PROVIDER', 'twilio');
  vi.stubEnv('TWILIO_ACCOUNT_SID', accountSid);
  vi.stubEnv('TWILIO_API_KEY_SID', `SK${'b'.repeat(32)}`);
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'test-key-secret');
  vi.stubEnv('TWILIO_FROM', '+15550000000');
  vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '');
}

// [REVIEW-PARTNER] getChannels() seals every channel for the store-review
// fiction: before the adapter runs, the seal reads (from the database) whether
// the recipient belongs to the fiction. The deadline under test is the
// ADAPTER's, armed when it starts — so these cases fake only the adapter's
// timer functions (the seal's database I/O must still run), and start the
// clock once the adapter has actually been reached.
const FAKE_TIMERS = { toFake: ['setTimeout', 'clearTimeout'] as ('setTimeout' | 'clearTimeout')[] };
async function untilAdapterReached(fetchStub: { mock: { calls: unknown[] } }): Promise<void> {
  for (let i = 0; i < 2_000 && fetchStub.mock.calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(fetchStub.mock.calls.length, 'the Twilio adapter was reached').toBeGreaterThan(0);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Twilio SMS whole-request deadline', () => {
  it('settles as timed out when the provider sends headers and then stalls the body', async () => {
    configure();
    let headersSent = false;
    const server = createServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"sid":');
      headersSent = true;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing stub address');
    const realFetch = globalThis.fetch;
    let headersReceived = false;
    vi.stubGlobal('fetch', async (_url: unknown, init: Parameters<typeof fetch>[1]) => {
      const res = await realFetch(`http://127.0.0.1:${address.port}/`, init);
      headersReceived = true;
      return res;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let outcome = 'still pending';
      const send = getChannels().sms.sendSms(RECIPIENT, 'test')
        .then(() => { outcome = 'unexpected success'; }, (error: Error) => { outcome = error.message; });
      await vi.waitUntil(() => headersReceived, { timeout: 2_000, interval: 5 });
      expect(headersSent).toBe(true);
      await vi.advanceTimersByTimeAsync(8_000);
      await vi.waitUntil(() => outcome !== 'still pending', { timeout: 1_000, interval: 5 }).catch(() => undefined);
      expect(outcome).toBe('Twilio SMS timed out');
      await send;
      // (the HTTP client keeps its own socket timers here; the fake-fetch cases below prove the deadline timer is cleared)
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['headers', 'json'])('settles even when the %s phase ignores abort', async (phase) => {
    configure();
    vi.useFakeTimers(FAKE_TIMERS);
    let signal: AbortSignal | undefined;
    const body = vi.fn(() => new Promise(() => {}));
    const fetchStub = vi.fn((_url: unknown, init: { signal: AbortSignal }) => {
      signal = init.signal;
      if (phase === 'headers') return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 201, json: body });
    });
    vi.stubGlobal('fetch', fetchStub);
    let outcome = 'still pending';
    const send = getChannels().sms.sendSms(RECIPIENT, 'test')
      .then(() => { outcome = 'unexpected success'; }, (error: Error) => { outcome = error.message; });
    await untilAdapterReached(fetchStub);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(outcome).toBe('still pending');
    await vi.advanceTimersByTimeAsync(1);
    if (phase === 'json') expect(body).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(outcome).toBe('Twilio SMS timed out');
    await send;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'http error', 'invalid body', 'network error'])('clears the deadline after %s', async (outcome) => {
    configure();
    vi.useFakeTimers(FAKE_TIMERS);
    const fetchStub = vi.fn();
    if (outcome === 'network error') fetchStub.mockRejectedValue(new Error('synthetic network error'));
    else if (outcome === 'http error') fetchStub.mockResolvedValue(new Response('unavailable', { status: 503 }));
    else if (outcome === 'invalid body') fetchStub.mockResolvedValue(new Response('not json', { status: 201 }));
    else fetchStub.mockResolvedValue(new Response(JSON.stringify({ sid: `SM${'a'.repeat(32)}` }), { status: 201 }));
    vi.stubGlobal('fetch', fetchStub);
    const send = getChannels().sms.sendSms(RECIPIENT, 'test');
    if (outcome === 'success') await expect(send).resolves.toEqual({ ref: `SM${'a'.repeat(32)}` });
    else await expect(send).rejects.toThrow(/^Twilio SMS /);
    expect(vi.getTimerCount()).toBe(0);
  });
});
