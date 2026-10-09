// @vitest-environment node
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let jpeg: Buffer;
let GET: typeof import('./route').GET;
const path = '/items/store/AbCdEfGh_jKlMn-p.jpg';
const get = (width = 160) => GET(new Request(`https://web.test/media${path}?w=${width}`), { params: Promise.resolve({ path: path.slice(1).split('/') }) });
beforeAll(async () => { jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: 'red' } }).jpeg().toBuffer(); });
beforeEach(async () => { vi.resetModules(); ({ GET } = await import('./route')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('store-photo source freshness and work bounds', () => {
  it.each(['3600', '7200'])('refuses an upstream answer already outside the removal window (Age %s)', async (age) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(jpeg), { headers: { Age: age } })));
    const response = await get();
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses a source whose remaining freshness expires during processing', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.stubGlobal('fetch', vi.fn(async () => {
      clock.mockReturnValue(1_002_000);
      return new Response(new Uint8Array(jpeg), { headers: { Age: '3599' } });
    }));
    const response = await get();
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['-1', 'Infinity', '1.5'])('refuses invalid upstream age %s', async (age) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(jpeg), { headers: { Age: age } })));
    expect((await get()).status).toBe(502);
  });

});
