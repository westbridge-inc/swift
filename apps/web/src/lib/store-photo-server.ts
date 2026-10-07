import sharp from 'sharp';
import { BROWSER_API_ORIGIN } from './browser-api-origin';
import { MEDIA_DEVICE_SIZES, MEDIA_IMAGE_SIZES, isStorePhotoPath } from './media-patterns';
import { StorePhotoCache, type CachedStorePhoto } from './store-photo-cache';

const CACHE_SECONDS = 3600;
const TIMEOUT_MS = 5000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
// Preserve Next's previous imgOptMaxInputPixels limit for camera uploads.
const MAX_INPUT_PIXELS = 268_402_689;
const WIDTH_QUERY = new RegExp(`^\\?w=(${[...MEDIA_DEVICE_SIZES, ...MEDIA_IMAGE_SIZES].join('|')})$`);
const cache = new StorePhotoCache(128, 16 * 1024 * 1024);
const jobs = new Set<{ path: string; revokedStatus: number }>();

class PhotoFailure extends Error {
  readonly status: number;
  constructor(status: number) { super('Photo unavailable'); this.status = status; }
}

function refusal(status: number): Response {
  return new Response(status === 404 || status === 410 ? 'Photo not found' : 'Photo unavailable', {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function success(entry: CachedStorePhoto): Response {
  return new Response(new Uint8Array(entry.body), { headers: {
    'Content-Type': 'image/webp',
    'Content-Length': String(entry.body.length),
    'Cache-Control': 'public, max-age=3600',
    // Every downstream cache inherits the original observation's age. A hot
    // LRU hit near expiry cannot grant a browser/CDN another fresh hour.
    Age: String(Math.max(0, Math.ceil((Date.now() - entry.freshAt) / 1000))),
    'X-Content-Type-Options': 'nosniff',
  } });
}

function revoke(path: string, status: number): void {
  cache.evictPath(path);
  for (const job of jobs) if (job.path === path) job.revokedStatus = status;
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Buffer> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_SOURCE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new PhotoFailure(502);
  }
  if (!response.body) throw new PhotoFailure(502);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new PhotoFailure(504);
      if (done) break;
      size += value.length;
      if (size > MAX_SOURCE_BYTES) { cancel(); throw new PhotoFailure(502); }
      parts.push(value);
    }
    return Buffer.concat(parts, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function rasterBytes(bytes: Buffer): boolean {
  return (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
}

/** Fixed upstream authority; neither host, path nor query can be supplied as a proxy target. */
export async function serveStorePhoto(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path: segments } = await context.params;
  const path = `/${segments.join('/')}`;
  const url = new URL(request.url);
  if (!isStorePhotoPath(path) || url.pathname !== `/media${path}`) return refusal(404);
  const widthMatch = WIDTH_QUERY.exec(url.search);
  if (!widthMatch) return refusal(400);
  const width = Number(widthMatch[1]);
  const key = `${path}?w=${width}`;
  const startedAt = Date.now();
  const cached = cache.get(key, startedAt);
  if (cached) return success(cached);
  if (jobs.size >= 4) return refusal(502);

  const controller = new AbortController();
  const job = { path, revokedStatus: 0 };
  jobs.add(job);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      job.revokedStatus = 504;
      controller.abort();
      reject(new PhotoFailure(504));
    }, TIMEOUT_MS);
  });
  const resize = async () => {
    const response = await fetch(`${BROWSER_API_ORIGIN}${path}`, {
      cache: 'no-store', redirect: 'error', credentials: 'omit', signal: controller.signal,
      // A cached API/CDN answer must revalidate too; its Age is retained below.
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (response.status === 404 || response.status === 410) {
      revoke(path, response.status);
      void response.body?.cancel().catch(() => {});
      throw new PhotoFailure(response.status);
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new PhotoFailure(502);
    }
    const upstreamAge = Number(response.headers.get('age') ?? 0);
    if (!Number.isSafeInteger(upstreamAge) || upstreamAge < 0 || upstreamAge >= CACHE_SECONDS) {
      void response.body?.cancel().catch(() => {});
      throw new PhotoFailure(502);
    }
    const bytes = await readBounded(response, controller.signal);
    if (!rasterBytes(bytes)) throw new PhotoFailure(502);
    const body = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
      .timeout({ seconds: TIMEOUT_MS / 1000 }).rotate()
      .resize(width, undefined, { withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    if (job.revokedStatus) throw new PhotoFailure(job.revokedStatus);
    const freshAt = startedAt - upstreamAge * 1000;
    const entry = { path, body, freshAt, expiresAt: freshAt + CACHE_SECONDS * 1000 };
    if (entry.expiresAt <= Date.now()) throw new PhotoFailure(502);
    cache.set(key, entry, Date.now());
    return success(entry);
  };
  try {
    return await Promise.race([resize(), deadline]);
  } catch (error) {
    return refusal(error instanceof PhotoFailure ? error.status : 502);
  } finally {
    clearTimeout(timer);
    jobs.delete(job);
  }
}
