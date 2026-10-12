// @vitest-environment node
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PATH = '/items/store/AbCdEfGh_jKlMn-p.jpg';
const HOUR = 3_600_000;
let jpeg: Buffer;
let GET: typeof import('./route').GET;
const request = (path = PATH, query = 'w=160') => new Request(`https://web.test/media${path}?${query}`);
const context = (path = PATH) => ({ params: Promise.resolve({ path: path.slice(1).split('/') }) });
const get = (path = PATH, query = 'w=160') => GET(request(path, query), context(path));
const upstream = (status = 200, body: BodyInit | null = new Uint8Array(jpeg), headers: HeadersInit = {}) =>
  new Response(body, { status, headers });
const noStore = (response: Response, status: number) => {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
};

beforeAll(async () => { jpeg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#bc5935' } }).jpeg().toBuffer(); });
beforeEach(async () => {
  vi.resetModules();
  ({ GET } = await import('./route'));
  vi.stubGlobal('fetch', vi.fn(async () => upstream()));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bounded store-photo route', () => {
  it.each([PATH, `/uploads${PATH}`])('resizes only the configured API photo to WebP: %s', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const output = Buffer.from(await response.arrayBuffer());
    expect(output.length).toBeLessThan(jpeg.length);
    expect(await sharp(output).metadata()).toMatchObject({ format: 'webp', width: 160, height: 120 });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(`http://vendor-api.test${path}`);
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'error', credentials: 'omit', headers: { 'Cache-Control': 'no-cache' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    '/uploads/avatars/user/AbCdEfGh_jKlMn-p.jpg', '/uploads/vehicles/car/AbCdEfGh_jKlMn-p.jpg',
    '/verification/store/AbCdEfGh_jKlMn-p.jpg', '/items/store/sub/AbCdEfGh_jKlMn-p.jpg',
    '/items/store/a.jpg', '/items/store/AbCdEfGh_jKlMn-p.jpg/extra',
    '/items/store/..%2f..%2fverification%2fid.jpg', '/items/store/%41bCdEfGh_jKlMn-p.jpg',
    '/items/%252e%252e/AbCdEfGh_jKlMn-p.jpg', '/items/store/AbCdEfGh_jKlMn-p.jpg%00',
    '/https://elsewhere.test/items/store/AbCdEfGh_jKlMn-p.jpg', '//elsewhere.test/items/store/AbCdEfGh_jKlMn-p.jpg',
  ])('rejects another host/path or encoded source without fetching: %s', async (path) => {
    noStore(await get(path), 404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects params that disagree with the literal URL, including normalized traversal', async () => {
    noStore(await GET(new Request(`https://web.test/media/items/store/../store/AbCdEfGh_jKlMn-p.jpg?w=160`), context('/items/store/../store/AbCdEfGh_jKlMn-p.jpg')), 404);
    noStore(await GET(request(), context(`/uploads${PATH}`)), 404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['w=161', 'w=0', 'w=-160', 'w=0160', 'w=160.0', 'w=1e2', 'w=%31%36%30', 'w=160&w=320', 'w=160&url=https://elsewhere.test/a', 'w=160&q=100', ''])('rejects a width/query outside the exact allow-list: %s', async (query) => {
    noStore(await get(PATH, query), 400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([48, 64, 96, 128, 160, 256, 320, 390, 640, 828, 1080, 1200, 1920])('accepts configured width %s', async (width) => {
    expect((await get(PATH, `w=${width}`)).status).toBe(200);
  });

  it('does not give browser caches another hour when serving the memory cache', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const first = await get();
    expect(first.headers.get('age')).toBe('0');
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + HOUR - 1000);
    const last = await get();
    expect(last.headers.get('age')).toBe('3599');
    expect(fetch).toHaveBeenCalledOnce();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + HOUR);
    vi.mocked(fetch).mockResolvedValue(upstream(404));
    noStore(await get(), 404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('includes upstream cache age in the single end-to-end hour', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.mocked(fetch).mockResolvedValue(upstream(200, new Uint8Array(jpeg), { Age: '3599' }));
    expect((await get()).headers.get('age')).toBe('3599');
    vi.spyOn(Date, 'now').mockReturnValue(1_001_000);
    vi.mocked(fetch).mockResolvedValue(upstream(410));
    noStore(await get(), 410);
  });
  it.each([404, 410])('passes API %s through and evicts every cached width of that photo', async (status) => {
    const first = await get(); expect(first.status).toBe(200);
    vi.mocked(fetch).mockResolvedValue(upstream(status));
    noStore(await get(PATH, 'w=320'), status);
    noStore(await get(), status);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('a concurrent success cannot repopulate a photo removed while it was resizing', async () => {
    let answer!: (_response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const pending = get();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    vi.mocked(fetch).mockResolvedValue(upstream(404));
    noStore(await get(PATH, 'w=320'), 404);
    answer(upstream());
    noStore(await pending, 404);
    noStore(await get(), 404);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([301, 403, 429, 500, 503])('never returns a stale success for upstream %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(upstream(status));
    noStore(await get(), 502);
  });
  it('network errors are no-store 502 without private diagnostics', async () => {
    vi.mocked(fetch).mockRejectedValue(Error('private-upstream-detail'));
    const response = await get(); noStore(response, 502);
    expect(await response.text()).not.toContain('private-upstream-detail');
  });
  it.each(['headers', 'body'])('a stalled %s times out within 5 seconds even if it ignores abort', async (stage) => {
    vi.useFakeTimers();
    if (stage === 'headers') vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    else vi.mocked(fetch).mockResolvedValue(upstream(200, new ReadableStream({ start() {} })));
    let completed: Response | undefined;
    void get().then((response) => { completed = response; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(completed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBeDefined();
    noStore(completed!, 504);
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(true);
  });
  it.each(['declared', 'streamed'])('caps %s source bytes at 5 MiB', async (mode) => {
    let cancelled = false;
    const oversized = Buffer.concat([jpeg, Buffer.alloc(5 * 1024 * 1024 + 1 - jpeg.length)]);
    let sent = false;
    const body = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(oversized)); } else c.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    vi.mocked(fetch).mockResolvedValue(upstream(200, body, mode === 'declared' ? { 'Content-Length': String(5 * 1024 * 1024 + 1) } : {}));
    noStore(await get(), 502);
    expect(cancelled).toBe(true);
  });
  it.each(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'not an image'])('refuses non-raster bytes', async (body) => {
    vi.mocked(fetch).mockResolvedValue(upstream(200, body));
    noStore(await get(), 502);
  });
  it('evicts least recently used entries at the real route limit', async () => {
    for (let i = 0; i < 128; i++) expect((await get(`/items/store${i}/AbCdEfGh_jKlMn-p.jpg`)).status).toBe(200);
    await get('/items/store0/AbCdEfGh_jKlMn-p.jpg');
    await get('/items/store128/AbCdEfGh_jKlMn-p.jpg');
    const count = vi.mocked(fetch).mock.calls.length;
    await get('/items/store0/AbCdEfGh_jKlMn-p.jpg');
    expect(fetch).toHaveBeenCalledTimes(count);
    await get('/items/store1/AbCdEfGh_jKlMn-p.jpg');
    expect(fetch).toHaveBeenCalledTimes(count + 1);
  });
});
