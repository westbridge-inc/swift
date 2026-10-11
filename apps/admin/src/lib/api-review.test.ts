import { describe, it, expect, vi, afterEach } from 'vitest';
import { waiveSubscriptionFee } from './api';
import { outcomeOf } from './outcome';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('money transport recovery', () => {
  it.each([200, 202])('an unreadable %s never becomes completed success', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{', { status })));
    await expect(waiveSubscriptionFee('synthetic-sub', 'Confirmed synthetic evidence')).rejects.toMatchObject({ code: 'RESPONSE_UNREADABLE' });
  });
  it('a stalled submission releases as uncertain after the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Request timed out', 'AbortError')));
    })));
    const results: unknown[] = [];
    const request = waiveSubscriptionFee('synthetic-sub', 'Confirmed synthetic evidence').catch((error) => { results.push(outcomeOf(error)); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(results).toMatchObject([{ code: 'TIMEOUT', uncertain: true }]);
    await request;
  });
});
