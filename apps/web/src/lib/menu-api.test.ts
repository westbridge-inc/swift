import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth';
import { ITEM_GONE_WORDS, refusalWords, sizedPhoto } from './menu-api';

// ---------------------------------------------------------------------------
// [REVIEW-G #2142 S4-1 · REVIEW-F S3-1/S4-3] The browser sizes a product photo before it is sent (as the phone does):
// long edge 1280 px, JPEG, upright, on white (a transparent PNG turned BLACK), and anything it cannot draw goes as
// chosen — never dropped, never a blank image. happy-dom has no image decoder or canvas, so both are stand-ins that
// record what the page asked of them.
// ---------------------------------------------------------------------------

type Calls = { bitmapOptions: unknown[]; fills: Array<{ style: string; w: number; h: number }>; draws: Array<{ w: number; h: number }>; order: string[]; encoded: Array<{ type: string; quality: number }> };
function stubDrawing(size: { width: number; height: number }, opts: { noContext?: boolean; emptyBlob?: boolean; decodeFails?: boolean } = {}): Calls {
  const calls: Calls = { bitmapOptions: [], fills: [], draws: [], order: [], encoded: [] };
  vi.stubGlobal('createImageBitmap', vi.fn(async (_file: Blob, options?: unknown) => {
    calls.bitmapOptions.push(options);
    if (opts.decodeFails) throw new Error('cannot decode');
    return { ...size, close: vi.fn() };
  }));
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'canvas') return realCreate(tag);
    const canvas = {
      width: 0, height: 0,
      getContext: () => (opts.noContext ? null : {
        fillStyle: '',
        fillRect(this: { fillStyle: string }, _x: number, _y: number, w: number, h: number) { calls.fills.push({ style: this.fillStyle, w, h }); calls.order.push('fill'); },
        drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => { calls.draws.push({ w, h }); calls.order.push('draw'); },
      }),
      toBlob: (done: (_b: Blob | null) => void, type: string, quality: number) => {
        calls.encoded.push({ type, quality });
        done(opts.emptyBlob ? new Blob([]) : new Blob(['jpeg-bytes'], { type }));
      },
    };
    return canvas as unknown as HTMLElement;
  }) as typeof document.createElement);
  return calls;
}
const photoFile = (name: string, bytes: number, type = 'image/jpeg') => new File([new Uint8Array(bytes)], name, { type });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('[REVIEW-G #2142 S4-1] a photo is sized in the browser before it is sent', () => {
  it('a 4000 x 3000 camera photo becomes a JPEG at most 1280 px on its long edge, named .jpg', async () => {
    const calls = stubDrawing({ width: 4000, height: 3000 });
    const out = await sizedPhoto(photoFile('IMG_0001.HEIC.jpeg', 3_000_000));
    expect(calls.draws).toEqual([{ w: 1280, h: 960 }]);
    expect(calls.encoded).toEqual([{ type: 'image/jpeg', quality: 0.8 }]);
    expect(out.blob.type).toBe('image/jpeg');
    expect(out.name).toBe('IMG_0001.HEIC.jpg');
  });

  it('a tall photo is limited on its height', async () => {
    const calls = stubDrawing({ width: 1500, height: 6000 });
    await sizedPhoto(photoFile('tall.png', 2_000_000, 'image/png'));
    expect(calls.draws).toEqual([{ w: 320, h: 1280 }]);
  });

  it('[REVIEW-F S3-1] it is drawn on white first (a transparent PNG would turn black as a JPEG)', async () => {
    const calls = stubDrawing({ width: 2000, height: 2000 });
    await sizedPhoto(photoFile('cutout.png', 900_000, 'image/png'));
    expect(calls.fills).toEqual([{ style: '#ffffff', w: 1280, h: 1280 }]);
    expect(calls.order).toEqual(['fill', 'draw']);
  });

  it('[REVIEW-F S4-3] it is drawn upright: the camera\'s orientation is applied (the re-encode drops the EXIF)', async () => {
    const calls = stubDrawing({ width: 4000, height: 3000 });
    await sizedPhoto(photoFile('a.jpg', 3_000_000));
    expect(calls.bitmapOptions).toEqual([{ imageOrientation: 'from-image' }]);
  });

  it('a small photo already under the size goes as chosen (no re-encode)', async () => {
    const calls = stubDrawing({ width: 800, height: 600 });
    const file = photoFile('small.jpg', 120_000);
    const out = await sizedPhoto(file);
    expect(out.blob).toBe(file);
    expect(calls.encoded).toEqual([]);
  });

  it.each([
    ['no 2D drawing context', { noContext: true }],
    ['an empty encode', { emptyBlob: true }],
    ['a photo the browser cannot decode', { decodeFails: true }],
  ])('[REVIEW-F S4-3] %s: the photo goes as chosen, never a blank image', async (_label, opts) => {
    stubDrawing({ width: 4000, height: 3000 }, opts);
    const file = photoFile('a.jpg', 3_000_000);
    const out = await sizedPhoto(file);
    expect(out.blob).toBe(file);
    expect(out.name).toBe('a.jpg');
  });

  it('no image decoder at all (an older browser): as chosen', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const file = photoFile('a.jpg', 3_000_000);
    expect((await sizedPhoto(file)).blob).toBe(file);
  });
});

describe('[REVIEW-F #2142 S4-2] a refusal in plain words', () => {
  it('the server\'s own words for a banned word', () => {
    expect(refusalWords(new ApiRequestError('Swift doesn\'t allow this item: alcohol.', 409, 'PROHIBITED_ITEM'))).toBe('Swift doesn\'t allow this item: alcohol.');
  });
  it('an item or section deleted on another device: plain words, never the internal id', () => {
    expect(refusalWords(new ApiRequestError('Category with id cm0abc123 not found', 404, 'NOT_FOUND'))).toBe(ITEM_GONE_WORDS);
  });
  it.each(['VALIDATION_ERROR', 'DUPLICATE', 'INTERNAL_ERROR'])('%s: no words for a person (the caller keeps its sentence)', (code) => {
    expect(refusalWords(new ApiRequestError('Unique constraint failed on the fields: (`sku`)', 409, code))).toBeNull();
  });
  it('not an answer from the server: the caller keeps its sentence', () => {
    expect(refusalWords(new Error('boom'))).toBeNull();
  });
});
