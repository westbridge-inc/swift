// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

// [MASTER-051] The public MMG return reads a POST body under a hard byte cap
// and a deadline BEFORE any form parser sees it. Run on Node's own Request
// (the runtime Next uses), not the DOM shim.

const UNKNOWN = 'Open the Swift app to see your weekly fee.';
const CAP = 256 * 1024;
const context = (outcome = 'success') => ({ params: Promise.resolve({ path: [outcome] }) });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function stub(state = 'CONFIRMED') {
  const fn = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { state } }), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}
const FORM = 'application/x-www-form-urlencoded';

/** A body that arrives in pieces and counts how much of it was ever pulled. */
function trickle(total: number, piece = 16 * 1024) {
  const seen = { bytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.bytes >= total) { controller.close(); return; }
      const n = Math.min(piece, total - seen.bytes);
      seen.bytes += n;
      controller.enqueue(new TextEncoder().encode('a'.repeat(n)));
    },
    cancel() { seen.cancelled = true; },
  });
  return { stream, seen };
}
const post = (body: BodyInit | null, headers: Record<string, string> = { 'content-type': FORM }) =>
  new Request('https://web.test/pay/mmg/success', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

describe('[MASTER-051] the MMG return body is bounded before it is parsed', () => {
  it('one byte over the cap is refused with 413, unparsed and unforwarded', async () => {
    const fetcher = stub();
    const request = post(`x=${'a'.repeat(CAP - 1)}`); // CAP + 1 bytes
    const parse = vi.spyOn(request, 'formData');
    const response = await POST(request, context());
    expect(response.status).toBe(413);
    expect(await response.text()).toContain(UNKNOWN);
    expect(parse).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('exactly the cap is read and parsed (then judged by the field rules as before)', async () => {
    const fetcher = stub();
    const response = await POST(post(`x=${'a'.repeat(CAP - 2)}`), context());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(UNKNOWN); // one value over 4096 characters: unreadable, as before
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a representative callback at normal size is forwarded unchanged', async () => {
    const fetcher = stub('CONFIRMING');
    const body = new URLSearchParams({ token: 'QUJDRA==', status: 'ok' });
    const response = await POST(post(body.toString()), context());
    expect(response.status).toBe(200);
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ outcome: 'success', params: { token: 'QUJDRA==', status: 'ok' } });
  });

  it('the largest reply the field rules accept (16 values of 4096 characters, every byte percent-encoded) fits under the cap and is forwarded', async () => {
    const fetcher = stub('CONFIRMING');
    // base64 that is all '+' and '/' percent-encodes to three bytes a character —
    // the worst case of a real reply — and the token at its 4096-character limit.
    const value = '+/'.repeat(2048);
    const fields = new URLSearchParams();
    fields.append('token', value);
    for (let i = 1; i < 16; i += 1) fields.append(`field_${String(i).padStart(2, '0')}`, value);
    const body = fields.toString();
    expect(body.length).toBeGreaterThan(190 * 1024);
    expect(body.length).toBeLessThan(CAP);
    const response = await POST(post(body), context());
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const sent = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.params.token).toBe(value);
    expect(Object.keys(sent.params)).toHaveLength(16);
  });

  it('a declared length over the cap is refused before a single byte is read', async () => {
    const fetcher = stub();
    const { stream, seen } = trickle(4 * CAP);
    const response = await POST(post(stream, { 'content-type': FORM, 'content-length': String(4 * CAP) }), context());
    expect(response.status).toBe(413);
    expect(seen.bytes).toBeLessThanOrEqual(64 * 1024); // at most what the stream queued on its own
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['no declared length', { 'content-type': FORM }],
    ['a misleading small declared length', { 'content-type': FORM, 'content-length': '10' }],
  ])('a streamed body crossing the cap with %s stops reading at the cap', async (_label, headers) => {
    const fetcher = stub();
    const { stream, seen } = trickle(16 * CAP);
    const response = await POST(post(stream, headers), context());
    expect(response.status).toBe(413);
    expect(seen.bytes).toBeLessThanOrEqual(CAP + 64 * 1024);
    expect(seen.cancelled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['-1', '1e9', 'abc', '10, 20'])('a malformed declared length (%s) is unreadable and nothing is forwarded', async (length) => {
    const fetcher = stub();
    const response = await POST(post('x=1', { 'content-type': FORM, 'content-length': length }), context());
    expect(await response.text()).toContain(UNKNOWN);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['application/json', 'text/plain', ''])('a content type the return never uses (%s) is unreadable', async (type) => {
    const fetcher = stub();
    const response = await POST(post('x=1', type ? { 'content-type': type } : {}), context());
    expect(await response.text()).toContain(UNKNOWN);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a body of a type the return never uses is not read at all', async () => {
    const fetcher = stub();
    const { stream, seen } = trickle(2 * CAP);
    const response = await POST(post(stream, { 'content-type': 'application/json' }), context());
    expect(await response.text()).toContain(UNKNOWN);
    expect(seen.cancelled).toBe(true);
    expect(seen.bytes).toBeLessThanOrEqual(64 * 1024); // at most what the stream queued on its own
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a body that stops arriving is abandoned at the deadline, unforwarded', async () => {
    vi.useFakeTimers();
    const fetcher = stub();
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('x=1')); },
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; },
    });
    const pending = POST(post(stalled), context());
    await vi.advanceTimersByTimeAsync(10_001);
    const response = await pending;
    expect(await response.text()).toContain(UNKNOWN);
    expect(cancelled).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a multipart file part is unreadable, and GET returns are unaffected', async () => {
    const fetcher = stub();
    const form = new FormData();
    form.append('token', new Blob(['QUJDRA=='], { type: 'text/plain' }), 'reply.txt');
    const multipart = await POST(new Request('https://web.test/pay/mmg/success', { method: 'POST', body: form }), context());
    expect(await multipart.text()).toContain(UNKNOWN);
    expect(fetcher).not.toHaveBeenCalled();
    const ok = await GET(new Request('https://web.test/pay/mmg/success?token=QUJDRA%3D%3D'), context());
    expect(ok.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
