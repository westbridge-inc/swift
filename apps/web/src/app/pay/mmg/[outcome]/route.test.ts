import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
const context = (outcome = 'success') => ({ params: Promise.resolve({ outcome }) });
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
    stub(state); const r = await GET(new Request('https://web.test/pay/mmg/success?reply=private-value&state=CONFIRMED'), context('error'));
    const html = await r.text(); expect(html).toContain(words); expect(html).not.toMatch(/private-value|must-not-render|99|<script/);
    for (const [other, text] of Object.entries(texts)) if (state !== other) expect(html).not.toContain(text);
    expect(html).toContain('href="swift://pay/mmg/return"'); expect(html).toContain('href="/weekly-fee"');
    expect(r.headers.get('x-robots-tag')).toBe('noindex'); expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('forwards every decoded GET value only to the API, with no-store and no redirects', async () => {
    const fetcher = stub('CONFIRMING'); await GET(new Request('https://web.test/pay/mmg/success?unknown=a%2Bb%26c&empty=&__proto__=opaque'), context());
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/billing\/mmg-checkout\/return$/); expect(init.method).toBe('POST'); expect(init.cache).toBe('no-store'); expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'success', params: JSON.parse('{"unknown":"a+b&c","empty":"","__proto__":"opaque"}') });
  });
  it.each(['application/x-www-form-urlencoded', 'multipart/form-data'])('forwards all POST fields (%s)', async (contentType) => {
    const fetcher = stub('UNKNOWN'); const fields = { unconfirmedFieldName: 'opaque+value', extra: 'x&y' };
    const body = contentType === 'multipart/form-data' ? new FormData() : new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    await POST(new Request('https://web.test/pay/mmg/error', { method: 'POST', body }), context('error'));
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'error', params: fields });
  });
  it('accepts exactly 16 entries of 4096 characters', async () => {
    const fetcher = stub('CONFIRMING'); const params = new URLSearchParams(Array.from({ length: 16 }, (_, i) => [`field${i}`, 'x'.repeat(4096)]));
    await GET(new Request(`https://web.test/pay/mmg/success?${params}`), context()); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['long', 'many'])('unreadable %s input is UNKNOWN without truncating or forwarding', async (kind) => {
    const fetcher = stub('CONFIRMED'); const params = kind === 'long' ? `x=${'x'.repeat(4097)}` : Array.from({ length: 17 }, (_, i) => `f${i}=x`).join('&');
    const r = await GET(new Request(`https://web.test/pay/mmg/success?${params}`), context());
    expect(await r.text()).toContain(texts.UNKNOWN); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['GET', 'POST-form', 'POST-multipart'])('preserves repeated keys in order for %s, letting only the API decide state', async (method) => {
    const fetcher = stub('CONFIRMED');
    const entries = [['reply', 'first'], ['other', 'x'], ['reply', 'second'], ['__proto__', 'one'], ['__proto__', 'two']];
    const body = method === 'POST-multipart' ? new FormData() : new URLSearchParams();
    for (const [key, value] of entries) body.append(key!, value!);
    const request = method === 'GET' ? new Request(`https://web.test/pay/mmg/error?${body}`) : new Request('https://web.test/pay/mmg/error', { method: 'POST', body });
    const response = await (method === 'GET' ? GET : POST)(request, context('error'));
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ outcome: 'error', params: JSON.parse('{"reply":["first","second"],"other":"x","__proto__":["one","two"]}') });
    expect(await response.text()).toContain(texts.CONFIRMED);
  });
  it('counts repeated values toward the limit of 16', async () => {
    const fetcher = stub('CONFIRMED');
    const values = new URLSearchParams(Array.from({ length: 17 }, () => ['reply', 'x']));
    const response = await GET(new Request(`https://web.test/pay/mmg/success?${values}`), context());
    expect(await response.text()).toContain(texts.UNKNOWN); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 413, 429, 500, 503])('API %s cannot imply paid', async (status) => {
    stub('CONFIRMED', status); const r = await GET(new Request('https://web.test/pay/mmg/success'), context()); expect(await r.text()).toContain(texts.UNKNOWN);
  });
  it('network errors never log tokens and render UNKNOWN', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('private-return-token')));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await GET(new Request('https://web.test/pay/mmg/success?reply=private-return-token'), context()); expect(await r.text()).toContain(texts.UNKNOWN); expect(log).not.toHaveBeenCalled();
  });
});
