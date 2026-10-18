// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [Row 108] The website's photo resizer refuses to decode more than about 40
// megapixels (the API caps uploads at the same size). It kept Next's old limit
// of 268,402,689 pixels, so one store photo could make the server expand a
// quarter-gigapixel canvas. The cap is the option the route hands sharp before
// any pixel is decoded; the real sharp still does the work.
// ---------------------------------------------------------------------------

const seen = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('sharp', async (importOriginal) => {
  const real = (await importOriginal<{ default: (..._args: unknown[]) => unknown }>()).default;
  const wrapped = (...args: unknown[]) => { seen.options.push(args[1]); return real(...args); };
  return { default: Object.assign(wrapped, real) };
});

const PATH = '/items/store/AbCdEfGh_jKlMn-p.jpg';
let jpeg: Buffer;
let GET: typeof import('./route').GET;

beforeAll(async () => {
  const sharp = (await import('sharp')).default as unknown as (_options: object) => { jpeg: () => { toBuffer: () => Promise<Buffer> } };
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#bc5935' } }).jpeg().toBuffer();
});
beforeEach(async () => {
  vi.resetModules();
  seen.options.length = 0;
  ({ GET } = await import('./route'));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(jpeg), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('[row 108] the store-photo resizer decodes at most about 40 megapixels', () => {
  it('hands sharp a 40,000,000-pixel input limit, and a normal photo still resizes', async () => {
    const response = await GET(new Request(`https://web.test/media${PATH}?w=160`), { params: Promise.resolve({ path: PATH.slice(1).split('/') }) });
    expect(response.status).toBe(200);
    const resize = seen.options.find((options) => options && typeof options === 'object' && 'limitInputPixels' in options);
    expect(resize).toMatchObject({ limitInputPixels: 40_000_000 });
  });
});
