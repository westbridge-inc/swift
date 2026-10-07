// @vitest-environment node
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ held: false, pending: [] as Array<(body: Buffer) => void> }));
vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  return { default: (...args: Parameters<typeof sharp>) => {
    const pipeline = actual.default(...args);
    if (native.held) pipeline.toBuffer = vi.fn(() => new Promise<Buffer>((resolve) => {
      native.pending.push(resolve);
    })) as typeof pipeline.toBuffer;
    return pipeline;
  } };
});

let jpeg: Buffer;
let webp: Buffer;
let GET: typeof import('./route').GET;
const path = (store: string) => `/items/${store}/AbCdEfGh_jKlMn-p.jpg`;
const get = (store = 'same', width = 160) => GET(
  new Request(`https://web.test/media${path(store)}?w=${width}`),
  { params: Promise.resolve({ path: path(store).slice(1).split('/') }) },
);
const upstream = () => new Response(new Uint8Array(jpeg));
const statuses = async (requests: Array<Promise<Response>>) => (await Promise.all(requests)).map((r) => r.status);

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: 'red' } }).jpeg().toBuffer();
  webp = await sharp(jpeg).resize(160).webp().toBuffer();
});
beforeEach(async () => {
  native.held = false;
  native.pending = [];
  vi.resetModules();
  ({ GET } = await import('./route'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('store-photo concurrency and overload recovery', () => {
  it('waits for all twelve distinct cold photos with at most four upstream jobs', async () => {
    let running = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
      return upstream();
    }));
    expect(await statuses(Array.from({ length: 12 }, (_, i) => get(`distinct-${i}`)))).toEqual(Array(12).fill(200));
    expect(fetch).toHaveBeenCalledTimes(12);
    expect(peak).toBe(4);
  });

  it('coalesces twelve identical cold requests and gives each a readable response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return upstream();
    }));
    const responses = await Promise.all(Array.from({ length: 12 }, () => get()));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(fetch).toHaveBeenCalledOnce();
    const bodies = await Promise.all(responses.map(async (r) => Buffer.from(await r.arrayBuffer())));
    expect(bodies[0]!.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
  });

  it('coalesces by photo and width, keeping separate resized variants', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream()));
    const responses = await Promise.all([get('same', 160), get('same', 320), get('same', 160), get('same', 320)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const widths = await Promise.all(responses.map(async (r) => (await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width));
    expect(widths).toEqual([160, 320, 160, 320]);
  });

  it('shares an upstream failure, then allows a healthy retry of the same key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const responses = await Promise.all(Array.from({ length: 12 }, () => get()));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(502));
    for (const response of responses) expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetch).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockImplementation(async () => upstream());
    expect((await get()).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([404, 410])('revokes a queued width on upstream %s without fetching it', async (status) => {
    vi.useFakeTimers();
    const release: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release.push(resolve); })));
    const first = get('removed', 160);
    const others = ['b', 'c', 'd'].map((store) => get(store));
    await vi.advanceTimersByTimeAsync(0);
    const queued = get('removed', 320);
    let queuedResponse: Response | undefined;
    void queued.then((r) => { queuedResponse = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    release[0]!(new Response(null, { status }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await first).status).toBe(status);
    expect(queuedResponse).toBeDefined();
    const revoked = queuedResponse!;
    expect(revoked.status).toBe(status);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const resolve of release.slice(1)) resolve(upstream());
    expect(await statuses(others)).toEqual([200, 200, 200]);
    vi.mocked(fetch).mockImplementation(async () => upstream());
    expect((await get('removed', 320)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('bounds waiting at 32 unique jobs, expires queued work without fetching, and recovers', async () => {
    vi.useFakeTimers();
    const release: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release.push(resolve); })));
    const admitted = Array.from({ length: 36 }, (_, i) => get(`overload-${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    let overflow: Response | undefined;
    void get('overflow').then((r) => { overflow = r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(overflow).toBeDefined();
    expect(overflow!.status).toBe(503);
    expect(overflow!.headers.get('cache-control')).toBe('no-store');
    const duplicate = get('overload-0');
    let fifth: Response | undefined;
    void admitted[4]!.then((r) => { fifth = r; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fifth).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await statuses([...admitted, duplicate])).toEqual(Array(37).fill(504));
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(init?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    // An upstream that ignores abort may resolve late. It must not start Sharp,
    // cache a late success, or admit the expired waiting jobs.
    native.held = true;
    for (const resolve of release) resolve(upstream());
    await vi.advanceTimersByTimeAsync(0);
    expect(native.pending).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    native.held = false;
    vi.mocked(fetch).mockImplementation(async () => upstream());
    expect((await get('overload-0')).status).toBe(200);
    expect((await get('overflow')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('holds all four work slots until native promises settle after the HTTP deadline', async () => {
    vi.useFakeTimers();
    native.held = true;
    vi.stubGlobal('fetch', vi.fn(async () => upstream()));
    const first = Array.from({ length: 4 }, (_, i) => get(`native-${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(native.pending).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await statuses(first)).toEqual([504, 504, 504, 504]);
    const second = Array.from({ length: 4 }, (_, i) => get(`later-${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(native.pending).toHaveLength(4);
    expect((await get('native-0')).status).toBe(504);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await statuses(second)).toEqual([504, 504, 504, 504]);
    native.held = false;
    for (const resolve of native.pending) resolve(webp);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect((await get('native-0')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
