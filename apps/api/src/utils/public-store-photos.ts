import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canReadBounded, getStorageProvider, type StorageProvider } from '../providers/storage/storage-provider';
import { runAsSystem } from '../plugins/tenant-context';
import { isVendorVisible, VISIBLE_VENDOR_SELECT } from '../modules/vendor/vendor-visibility';
import { feePausePredicate, readFeePause } from '../modules/billing/mmg-pause';
import { hiddenAmong, storeHiddenFromCustomers } from '../modules/compliance/prohibited-gate';
import { MAX_IMAGE_PIXELS, sniffImageType } from './images';

// ---------------------------------------------------------------------------
// [IMAGES-E2E] The public door for stores' own photos.
//
// A store's menu photo (vendor.routes POST /items/:id/image) is saved where the
// storage provider says. On local disk that is a path ("/uploads/items/<store>/
// <file>", served by public-uploads.ts). In object storage, which every managed
// runtime uses (staging and production run STORAGE_PROVIDER=s3), it is the bare
// KEY ("items/<store>/<file>") of a PRIVATE bucket. Both apps put the API origin
// in front of a value that is not a full address (the phone's lib/images
// mediaUrl, the website's lib/media mediaUrl and its /media resizer), so they
// ask for "<api>/items/<store>/<file>" — and nothing answered: a store's photo
// never reached a customer.
//
// This answers exactly that address, by one rule:
//   - ONLY the stores' photo folder `items/<store>/`, and only a name shaped
//     like the upload's own (createOpaqueStorageName: 16 random characters and
//     an optional short extension). Strict characters, no dots in the name, no
//     separators: identity documents, selfies, proof photos, chat, ads and every
//     other upload live under other folders, and no address here can name them;
//   - ONLY a store customers may see (vendor-visibility: ACTIVE, verified, its
//     operator active, its subscription operating), that is not hidden from
//     customers (a banned category, or its own words waiting for a person), and
//     whose owner's account is ACTIVE (a closed account publishes nothing even
//     before its store is wound down);
//   - ONLY a photo that store still shows: a live menu item that is not held or
//     banned, a live menu section, its logo or its cover. A replaced photo, a key
//     typed into ANOTHER store's row and a photo nobody references publish
//     nothing;
//   - a check that cannot be made is a refusal, never a pass;
//   - the stored bytes are read within a size cap and a deadline, then DRAWN
//     AGAIN (sharp): turned upright, converted to sRGB, every metadata block
//     dropped (EXIF/GPS, XMP, IPTC, comments AND the ICC profile, whose text
//     tags can name a device), and sized: the long edge at most 1600 px, or a
//     list width from a fixed ladder (?w=). The type is decided by the bytes.
//   - Cache: a day (`public, max-age=86400`) with a weak ETag; never `immutable`,
//     so a photo a store removes stops being served within the day everywhere.
//     A refusal is never cached.
// ---------------------------------------------------------------------------

/** The stores' photo folder (vendor.routes: `items/${vendorId}`). */
export const STORE_PHOTO_FOLDER = 'items';
/** The upload ceiling (app.ts multipart fileSize): nothing larger was ever accepted. */
export const STORE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** The long edge of a photo asked for without a width: the largest any screen draws. */
export const STORE_PHOTO_FULL_EDGE = 1600;
/** The list widths a client may ask for (?w=). A fixed ladder, so a caller cannot make one photo into a thousand renders. */
export const STORE_PHOTO_WIDTHS = [160, 320, 480, 640, 960, 1280] as const;
export const STORE_PHOTO_CACHE_CONTROL = 'public, max-age=86400';
/** Bumped whenever the drawing changes, so an old ETag never claims new bytes. */
const RENDER_VERSION = 'r1';

/** A store id: the folder name the upload route writes (a cuid). */
const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** createOpaqueStorageName: nanoid(16) plus the extension path.extname gave. The
 *  same shape the website's /media route accepts (web lib/media-patterns). */
const PHOTO_NAME = /^[A-Za-z0-9_-]{16}(?:\.[A-Za-z0-9_-]{1,16})?$/;

const DECISION_TTL_MS = 30_000;
const DECISION_MAX = 5_000;
const RENDER_CACHE_BYTES = 48 * 1024 * 1024;
const RENDER_MAX_ACTIVE = 2;
const RENDER_MAX_WAITING = 64;

function readDeadlineMs(): number {
  const n = Number(process.env['PUBLIC_PHOTO_READ_TIMEOUT_MS'] ?? 5000);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 100), 30_000) : 5000;
}

// ── Is this photo public? ────────────────────────────────────────────────────

const decisions = new Map<string, { shown: boolean; at: number }>();

/** True while a store customers may see shows this exact photo somewhere. */
export async function storeShowsPhoto(app: FastifyInstance, vendorId: string, file: string): Promise<boolean> {
  // Both shapes the upload has ever saved for this one object.
  const stored = [`${STORE_PHOTO_FOLDER}/${vendorId}/${file}`, `/uploads/${STORE_PHOTO_FOLDER}/${vendorId}/${file}`];
  // A photo request carries no session, so no tenant is bound. The store is
  // named by the address; this reads that one store, whatever its operator,
  // and the visibility predicate below is the wall.
  return runAsSystem('public-store-photo', async () => {
    const store = await app.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { ...VISIBLE_VENDOR_SELECT, logoUrl: true, coverImageUrl: true, owner: { select: { user: { select: { status: true } } } } },
    });
    if (!store || store.owner?.user?.status !== 'ACTIVE') return false;
    const feePause = store.subscription
      ? await readFeePause(app.prisma, process.env, store.subscription.id)
      : feePausePredicate(false);
    if (!isVendorVisible(store, feePause)) return false;
    if (await storeHiddenFromCustomers(app.prisma, vendorId)) return false;
    if (stored.includes(store.logoUrl ?? '') || stored.includes(store.coverImageUrl ?? '')) return true;
    const section = await app.prisma.category.findFirst({
      where: { vendorId, imageUrl: { in: stored }, archivedAt: null },
      select: { id: true },
    });
    if (section) return true;
    const items = await app.prisma.item.findMany({
      where: { vendorId, imageUrl: { in: stored }, archivedAt: null },
      select: { id: true },
      take: 20,
    });
    if (items.length === 0) return false;
    const hidden = await hiddenAmong(app.prisma, items.map((i) => i.id));
    return items.some((i) => !hidden.has(i.id));
  });
}

async function decide(app: FastifyInstance, vendorId: string, file: string, now: number): Promise<boolean> {
  const key = `${vendorId}/${file}`;
  const hit = decisions.get(key);
  if (hit && now - hit.at < DECISION_TTL_MS) return hit.shown;
  const shown = await storeShowsPhoto(app, vendorId, file);
  if (decisions.size >= DECISION_MAX) decisions.delete(decisions.keys().next().value!);
  decisions.set(key, { shown, at: now });
  return shown;
}

// ── Drawing ──────────────────────────────────────────────────────────────────

type Rendered = { body: Buffer; type: 'image/jpeg' | 'image/png' | 'image/webp' };

/** Draw a stored photo for the public: upright, sRGB, no metadata at all (sharp's
 *  default drops EXIF, XMP, IPTC and the ICC profile after converting through it),
 *  long edge capped (or a list width), the same format it came in. Null = refused. */
export async function renderStorePhoto(bytes: Buffer, width: number | null): Promise<Rendered | null> {
  const type = sniffImageType(bytes);
  if (!type) return null;
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).timeout({ seconds: 10 }).rotate();
    const sized = width === null
      ? image.resize({ width: STORE_PHOTO_FULL_EDGE, height: STORE_PHOTO_FULL_EDGE, fit: 'inside', withoutEnlargement: true })
      : image.resize({ width, withoutEnlargement: true });
    const body = type === 'image/jpeg'
      ? await sized.jpeg({ quality: 80, progressive: true }).toBuffer()
      : type === 'image/png'
        ? await sized.png({ compressionLevel: 8 }).toBuffer()
        : await sized.webp({ quality: 80 }).toBuffer();
    return { body, type };
  } catch {
    return null;
  }
}

class LruBytes {
  private map = new Map<string, Rendered>();
  private total = 0;
  constructor(private readonly budget: number) {}
  get(key: string): Rendered | undefined {
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); }
    return hit;
  }
  set(key: string, value: Rendered): void {
    if (value.body.length > this.budget / 8) return; // one photo never crowds out the rest
    const old = this.map.get(key);
    if (old) { this.total -= old.body.length; this.map.delete(key); }
    this.map.set(key, value);
    this.total += value.body.length;
    while (this.total > this.budget) {
      const [k, v] = this.map.entries().next().value!;
      this.map.delete(k);
      this.total -= v.body.length;
    }
  }
  clear(): void { this.map.clear(); this.total = 0; }
}

const rendered = new LruBytes(RENDER_CACHE_BYTES);
const inFlight = new Map<string, Promise<Rendered | null | 'deadline' | 'failed'>>();
let active = 0;
const waiting: Array<() => void> = [];

async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T | 'busy'> {
  if (active >= RENDER_MAX_ACTIVE) {
    if (waiting.length >= RENDER_MAX_WAITING) return 'busy';
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); else active -= 1;
  }
}

/** Test seam: forget every decision and drawing. */
export function resetStorePhotoCachesForTests(): void {
  decisions.clear();
  rendered.clear();
}

function weakEtag(vendorId: string, file: string, width: number | null): string {
  const digest = createHash('sha256').update(`${RENDER_VERSION}|${vendorId}/${file}|${width ?? 'full'}`).digest('base64url').slice(0, 27);
  return `W/"${digest}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.slice(2);
  return header.split(',').some((t) => { const v = t.trim(); return v === '*' || v === etag || v === bare || `W/${v}` === etag; });
}

// ── The door ─────────────────────────────────────────────────────────────────

export async function serveStorePhoto(
  app: FastifyInstance,
  request: FastifyRequest<{ Params: { vendorId: string; file: string }; Querystring: Record<string, string | undefined> }>,
  reply: FastifyReply,
  storage: StorageProvider,
) {
  const refuse = (code: number) => reply.code(code).header('Cache-Control', 'no-store').send();
  const { vendorId, file } = request.params;
  if (!STORE_ID.test(vendorId) || !PHOTO_NAME.test(file)) return refuse(404);
  const query = request.query ?? {};
  const keys = Object.keys(query);
  if (keys.some((k) => k !== 'w')) return refuse(400);
  let width: number | null = null;
  if (query['w'] !== undefined) {
    width = Number(query['w']);
    if (!(STORE_PHOTO_WIDTHS as readonly number[]).includes(width)) return refuse(400);
  }

  let shown = false;
  try {
    shown = await decide(app, vendorId, file, Date.now());
  } catch (err) {
    request.log.error({ err }, '[IMAGES-E2E] could not decide whether a store photo is public; not served');
  }
  if (!shown) return refuse(404);

  const etag = weakEtag(vendorId, file, width);
  const ok = (r: Rendered) => reply
    .header('Content-Type', r.type)
    .header('Cache-Control', STORE_PHOTO_CACHE_CONTROL)
    .header('ETag', etag)
    .header('X-Content-Type-Options', 'nosniff')
    // The website draws these from its own origin through /media, and the API's
    // default (helmet) is same-origin; a photo is public, so any page may embed it.
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(r.body);
  if (etagMatches(request.headers['if-none-match'], etag)) {
    return reply.code(304).header('Cache-Control', STORE_PHOTO_CACHE_CONTROL).header('ETag', etag).send();
  }

  const cacheKey = `${vendorId}/${file}|${width ?? 'full'}`;
  const cached = rendered.get(cacheKey);
  if (cached) return ok(cached);

  let job = inFlight.get(cacheKey);
  if (!job) {
    job = (async () => {
      const outcome = await withRenderSlot(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), readDeadlineMs());
        try {
          if (!canReadBounded(storage)) throw new Error('storage provider has no bounded read');
          const bytes = await storage.getObjectWithin(`${STORE_PHOTO_FOLDER}/${vendorId}/${file}`, STORE_PHOTO_MAX_BYTES, controller.signal);
          if (!bytes) return null;
          const drawn = await renderStorePhoto(bytes, width);
          if (drawn) rendered.set(cacheKey, drawn);
          return drawn;
        } catch (err) {
          if (controller.signal.aborted) return 'deadline' as const;
          request.log.error({ err }, '[IMAGES-E2E] store photo read failed');
          return 'failed' as const;
        } finally {
          clearTimeout(timer);
        }
      });
      return outcome === 'busy' ? 'failed' as const : outcome;
    })();
    inFlight.set(cacheKey, job);
    void job.finally(() => inFlight.delete(cacheKey));
  }
  const result = await job;
  if (result === 'deadline') return refuse(504);
  if (result === 'failed') return reply.code(503).header('Cache-Control', 'no-store').header('Retry-After', '5').send();
  if (!result) return refuse(404);
  return ok(result);
}

export function registerPublicStorePhotos(app: FastifyInstance, storage: StorageProvider = getStorageProvider()) {
  app.get<{ Params: { vendorId: string; file: string }; Querystring: Record<string, string | undefined> }>(
    `/${STORE_PHOTO_FOLDER}/:vendorId/:file`,
    // Its own allowance: one screen of a store is dozens of photos, and many
    // phones share one address on the mobile networks.
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => serveStorePhoto(app, request, reply, storage),
  );
}
