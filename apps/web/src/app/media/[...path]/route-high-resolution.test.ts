// @vitest-environment node
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './route';

afterEach(() => vi.unstubAllGlobals());

it('preserves previously accepted high-resolution camera photos within the source byte ceiling', async () => {
  // The phone's picker uploads at quality 0.8, without a pixel resize. This
  // source exceeds 16 MP but fits the API's existing 5 MiB upload ceiling.
  const source = await sharp({ create: { width: 4097, height: 4096, channels: 3, background: '#bc5935' } }).jpeg({ quality: 80 }).toBuffer();
  expect(source.length).toBeLessThan(5 * 1024 * 1024);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(source))));
  const path = '/items/camera/AbCdEfGh_jKlMn-p.jpg';
  const response = await GET(new Request(`https://web.test/media${path}?w=160`), { params: Promise.resolve({ path: path.slice(1).split('/') }) });
  expect(response.status).toBe(200);
  expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({ format: 'webp', width: 160 });
});
