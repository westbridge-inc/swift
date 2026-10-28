import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
const context = (outcome = 'success') => ({ params: Promise.resolve({ path: [outcome] }) });
const texts = {
  CONFIRMED: 'Payment received. Your Swift weekly fee is paid.',
  CONFIRMING: "We're confirming your payment with MMG. Don't pay again. You can close this page.",
  NOT_PAID: "MMG didn't complete this payment. You can try again in the Swift app.",
  UNKNOWN: 'Open the Swift app to see your weekly fee.',
};
afterEach(() => vi.unstubAllGlobals());
function stub(state: string, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { state, ref: 'must-not-render', amountGyd: 99 } }), { status }));
  vi.stubGlobal('fetch', fn); return fn;
}
describe('MMG return document', () => {
  it.each(Object.entries(texts))('renders only API %s even on an unrelated outcome URL', async (state, words) => {
    stub(state); const r = await GET(new Request('https://web.test/pay/mmg/success?reply=private-value&state=CONFIRMED&token=abc'), context('error'));
    const html = await r.text(); expect(html).toContain(words); expect(html).not.toMatch(/private-value|must-not-render|99|<script/);
    for (const [other, text] of Object.entries(texts)) if (state !== other) expect(html).not.toContain(text);
    expect(html).toContain('href="swift://pay/mmg/return"'); expect(html).toContain('href="/weekly-fee"');
    expect(r.headers.get('x-robots-tag')).toBe('noindex'); expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('forwards every decoded GET value only to the API, with no-store and no redirects', async () => {
    const fetcher = stub('CONFIRMING'); await GET(new Request('https://web.test/pay/mmg/success?unknown=a%2Bb%26c&empty=&__proto__=opaque&token=abc'), context());
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/billing\/mmg-checkout\/return$/); expect(init.method).toBe('POST'); expect(init.cache).toBe('no-store'); expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'success', params: JSON.parse('{"unknown":"a+b&c","empty":"","__proto__":"opaque","token":"abc"}') });
  });
  it.each(['application/x-www-form-urlencoded', 'multipart/form-data'])('forwards all POST fields (%s)', async (contentType) => {
    const fetcher = stub('UNKNOWN'); const fields = { unconfirmedFieldName: 'opaque+value', extra: 'x&y', token: 'abc' };
    const body = contentType === 'multipart/form-data' ? new FormData() : new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    await POST(new Request('https://web.test/pay/mmg/error', { method: 'POST', body }), context('error'));
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'error', params: fields });
  });
  it('accepts exactly 16 entries of 4096 characters', async () => {
    const fetcher = stub('CONFIRMING'); const params = new URLSearchParams([...Array.from({ length: 15 }, (_, i) => [`field${i}`, 'x'.repeat(4096)]), ['token', 'x'.repeat(4096)]]);
    await GET(new Request(`https://web.test/pay/mmg/success?${params}`), context()); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['long', 'many'])('unreadable %s input is UNKNOWN without truncating or forwarding', async (kind) => {
    const fetcher = stub('CONFIRMED'); const params = kind === 'long' ? `x=${'x'.repeat(4097)}` : Array.from({ length: 17 }, (_, i) => `f${i}=x`).join('&');
    const r = await GET(new Request(`https://web.test/pay/mmg/success?${params}`), context());
    expect(await r.text()).toContain(texts.UNKNOWN); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST-form', 'POST-multipart'])('preserves repeated keys in order for %s, letting only the API decide state', async (method) => {
    const fetcher = stub('CONFIRMED');
    const entries = [['reply', 'first'], ['other', 'x'], ['reply', 'second'], ['__proto__', 'one'], ['__proto__', 'two'], ['token', 'abc']];
    const body = method === 'POST-multipart' ? new FormData() : new URLSearchParams();
    for (const [key, value] of entries) body.append(key!, value!);
    const request = method === 'GET' ? new Request(`https://web.test/pay/mmg/error?${body}`) : new Request('https://web.test/pay/mmg/error', { method: 'POST', body });
    const response = await (method === 'GET' ? GET : POST)(request, context('error'));
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'error', params: JSON.parse('{"reply":["first","second"],"other":"x","__proto__":["one","two"],"token":"abc"}') });
    expect(await response.text()).toContain(texts.CONFIRMED);
  });
  it('counts repeated values toward the limit of 16', async () => {
    const fetcher = stub('CONFIRMED');
    const values = new URLSearchParams(Array.from({ length: 17 }, () => ['reply', 'x']));
    const response = await GET(new Request(`https://web.test/pay/mmg/success?${values}`), context());
    expect(await response.text()).toContain(texts.UNKNOWN); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 413, 429, 500, 503])('API %s cannot imply paid', async (status) => {
    stub('CONFIRMED', status); const r = await GET(new Request('https://web.test/pay/mmg/success?token=abc'), context()); expect(await r.text()).toContain(texts.UNKNOWN);
  });
  it('network errors never log tokens and render UNKNOWN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('private-return-token')));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await GET(new Request('https://web.test/pay/mmg/success?reply=private-return-token&token=abc'), context()); expect(await r.text()).toContain(texts.UNKNOWN); expect(log).not.toHaveBeenCalled();
  });
});

describe('[SEC-DOS F8] the partner\'s own address, and one more try when the API is busy', () => {
  const busy = () => new Response(JSON.stringify({ success: false, error: { code: 'TRY_AGAIN', details: { retryAfterSeconds: 1 } } }), { status: 503 });
  const answer = (state: string) => new Response(JSON.stringify({ success: true, data: { state } }), { status: 200 });

  it('forwards the first X-Forwarded-For address, and only an IP literal', async () => {
    const fetcher = stub('CONFIRMING');
    await GET(new Request('https://web.test/pay/mmg/success?token=abc', { headers: { 'x-forwarded-for': '198.51.100.7, 172.20.0.2' } }), context());
    await GET(new Request('https://web.test/pay/mmg/success?token=abc', { headers: { 'x-forwarded-for': 'not-an-address' } }), context());
    await GET(new Request('https://web.test/pay/mmg/success?token=abc'), context());
    const sent = fetcher.mock.calls.map((call) => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)['X-Forwarded-For']);
    expect(sent).toEqual(['198.51.100.7', undefined, undefined]);
  });

  it('a busy API is asked once more after its wait, and that answer renders', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(answer('CONFIRMED'));
      vi.stubGlobal('fetch', fetcher);
      const pending = GET(new Request('https://web.test/pay/mmg/success?token=abc'), context());
      await vi.advanceTimersByTimeAsync(1_000);
      const html = await (await pending).text();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(html).toContain(texts.CONFIRMED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('busy twice renders UNKNOWN; any other failure is never retried', async () => {
    vi.useFakeTimers();
    try {
      let fetcher = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(busy());
      vi.stubGlobal('fetch', fetcher);
      const pending = GET(new Request('https://web.test/pay/mmg/success?token=abc'), context());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await (await pending).text()).toContain(texts.UNKNOWN);
      expect(fetcher).toHaveBeenCalledTimes(2);
      fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
      vi.stubGlobal('fetch', fetcher);
      expect(await (await GET(new Request('https://web.test/pay/mmg/success?token=abc'), context())).text()).toContain(texts.UNKNOWN);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[SEC-DOS F8] the relay refuses what the API would never open, and limits each partner', () => {
  it('a return with no token field is never relayed', async () => {
    const fetcher = stub('CONFIRMED');
    for (const url of ['https://web.test/pay/mmg/success', 'https://web.test/pay/mmg/success?reply=x&other=y', 'https://web.test/pay/mmg/error?tokenx=1']) {
      expect(await (await GET(new Request(url), context())).text()).toContain(texts.UNKNOWN);
    }
    expect(fetcher).not.toHaveBeenCalled();
    // any letter case of the field is the field
    await GET(new Request('https://web.test/pay/mmg/success?TOKEN=abc'), context());
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('each partner address gets 20 relayed returns a minute; another partner is unaffected', async () => {
    const fetcher = stub('CONFIRMING');
    const from = (ip: string) => new Request('https://web.test/pay/mmg/success?token=abc', { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 20; i += 1) expect((await GET(from('198.51.100.20'), context())).status).toBe(200);
    const over = await GET(from('198.51.100.20'), context());
    expect(over.status).toBe(429);
    expect(await over.text()).toContain(texts.UNKNOWN);
    expect(fetcher).toHaveBeenCalledTimes(20);
    expect((await GET(from('198.51.100.21'), context())).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(21);
  });
});
