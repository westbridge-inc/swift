import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canReadBounded, getStorageProvider } from '../providers/storage/storage-provider';
import { runAsSystem } from '../plugins/tenant-context';
import { visibleVendorForCaller } from '../modules/vendor/vendor-visibility';
import { imageContentType, stripImageMetadataStrict } from './images';

// ---------------------------------------------------------------------------
// [PUBLIC-PHOTOS] Stores' own photos, whatever the storage provider.
//
// A store's menu photo upload (vendor.routes POST /items/:id/image) saves what
// the storage provider returns. The local provider returns a path
// ("/uploads/items/<store>/<file>"). The object storage provider used on every
// managed runtime returns the bare object KEY ("items/<store>/<file>") of a
// PRIVATE bucket, and nothing answered for it: every client puts the API
// origin in front of a value that is not a full address (the phone app's
// mediaUrl, the website's mediaUrl), so they asked for
// "<api>/items/<store>/<file>" and drew a broken photo.
//
// This answers exactly that address, and the local one, by ONE rule:
//   - ONLY the stores' photo folder `items/` — the one folder only the menu
//     photo upload writes, and only after the bytes passed the image sniff.
//     Identity documents, selfies, proof photos, chat and every other upload
//     live in other folders, which are not routed here at all;
//   - ONLY a store a guest may see — the public catalogue's own wall
//     (vendor-visibility: an ACTIVE, verified store of an active PRODUCTION
//     operator whose subscription operates). A review fiction, a switched-off
//     operator, a store not yet approved and a partner who closed their
//     account (wind-down suspends the store) publish nothing;
//   - ONLY a photo that store still uses: a menu item, a menu section, its
//     logo or cover. A replaced photo stops being served, and a key typed into
//     another store's field publishes nothing;
//   - ONLY while the store's owner still has an account: deletion commits the
//     account first and winds the store down after, and that second step can
//     fail — the closed account alone already stops the photos;
//   - ONLY real JPEG/PNG/WebP bytes within the upload size limit, typed from
//     the bytes themselves, read within a deadline, and served with every
//     metadata tag removed (a camera's GPS position of the shop among them);
//     a photo whose tags cannot be removed is not served;
//   - cached for an hour, never `immutable`, so a removal takes effect within
//     the hour; a refusal is never cached.
// ---------------------------------------------------------------------------

/** The stores' photo folder (vendor.routes: `items/${vendorId}`). */
export const STORE_PHOTO_FOLDER = 'items';
/** The upload ceiling (app.ts multipart fileSize): nothing larger was ever accepted. */
export const STORE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** How long a served photo may be reused without asking again. */
export const STORE_PHOTO_CACHE = 'public, max-age=3600';

/** A store id: the folder name the upload route writes. No dots, no separators. */
const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** createOpaqueStorageName: 16 random characters, then the extension
 *  `path.extname` gave. New menu photos are named by their bytes
 *  (.jpg/.png/.webp); older ones kept the uploaded file's own extension,
 *  whatever it was ("photo.jpg-large", "dish.jpeg_large_export"). The name is
 *  only ever compared with what a store's row holds, exactly, so the extension
 *  may be any printable text up to 64 characters — but never another dot, a
 *  separator or a control character. */
const PHOTO_ID = /^[A-Za-z0-9_-]{16}$/;
function photoNameAccepted(file: string): boolean {
  const dot = file.indexOf('.');
  if (dot === -1) return PHOTO_ID.test(file);
  const ext = file.slice(dot + 1);
  if (!PHOTO_ID.test(file.slice(0, dot)) || ext.length < 1 || ext.length > 64) return false;
  for (const ch of ext) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || ch === '.' || ch === '/' || ch === '\\') return false;
  }
  return true;
}

/** The storage read deadline: connect, answer and body together. */
function readDeadlineMs(): number {
  const n = Number(process.env['PUBLIC_PHOTO_READ_TIMEOUT_MS'] ?? 5000);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 100), 30_000) : 5000;
}

class ReadDeadline extends Error {}

/** True while a store a guest may see shows this exact photo somewhere. */
async function storeShowsPhoto(app: FastifyInstance, vendorId: string, stored: string): Promise<boolean> {
  // A guest asks, so no tenant is bound; this names itself instead. Unbound,
  // visibleVendorForCaller() is the guest's wall — the same predicate every
  // public catalogue read uses. It answers yes or no; nothing else leaves.
  return runAsSystem('public-store-photo', async () => {
    const store = await app.prisma.vendor.findFirst({
      // The account-deletion state is the owner's, not the store's: a closed
      // account is DEACTIVATED before its store is wound down.
      where: { id: vendorId, ...visibleVendorForCaller(), owner: { user: { status: { not: 'DEACTIVATED' } } } },
      select: { coverImageUrl: true, logoUrl: true },
    });
    if (!store) return false;
    if (store.coverImageUrl === stored || store.logoUrl === stored) return true;
    if (await app.prisma.item.findFirst({ where: { vendorId, imageUrl: stored }, select: { id: true } })) return true;
    return (await app.prisma.category.findFirst({ where: { vendorId, imageUrl: stored }, select: { id: true } })) !== null;
  });
}

export interface StorePhotoSource {
  vendorId: string;
  file: string;
  /** The exact value a store's row holds for this photo. */
  stored: (vendorId: string, file: string) => string;
  /** Read at most `maxBytes`; null = missing or larger. Honour `signal`. */
  read: (vendorId: string, file: string, maxBytes: number, signal: AbortSignal) => Promise<Buffer | null>;
}

/** The one rule, for every address a store photo is served at. */
export async function serveStorePhoto(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, source: StorePhotoSource) {
  const notServed = () => reply.code(404).header('Cache-Control', 'no-store').send();
  const { vendorId, file } = source;
  if (!STORE_ID.test(vendorId) || !photoNameAccepted(file)) return notServed();
  if (!(await storeShowsPhoto(app, vendorId, source.stored(vendorId, file)))) return notServed();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ReadDeadline()); }, readDeadlineMs());
  });
  const reading = source.read(vendorId, file, STORE_PHOTO_MAX_BYTES, controller.signal);
  reading.catch(() => undefined); // a read that loses the race settles quietly
  let bytes: Buffer | null;
  try {
    bytes = await Promise.race([reading, deadline]);
  } catch (err) {
    if (err instanceof ReadDeadline) {
      request.log.warn('[PUBLIC-PHOTOS] storage read passed its deadline');
      return reply.code(504).header('Cache-Control', 'no-store').send();
    }
    request.log.error({ err }, '[PUBLIC-PHOTOS] storage read failed');
    return reply.code(503).header('Cache-Control', 'no-store').send();
  } finally {
    clearTimeout(timer);
  }
  const type = bytes ? imageContentType(bytes) : null;
  // Published without its tags, whatever was stored (older uploads could keep
  // them); a photo whose tags cannot be removed is not published at all.
  const clean = bytes && type ? stripImageMetadataStrict(bytes, type) : null;
  if (!clean || !type) {
    if (bytes && type) request.log.warn('[PUBLIC-PHOTOS] stored photo did not parse; not served');
    return notServed();
  }

  return reply
    .header('Content-Type', type)
    .header('Cache-Control', STORE_PHOTO_CACHE)
    .header('X-Content-Type-Options', 'nosniff')
    // The website draws these from another origin (its own pages and its
    // image optimiser), so the photo may be embedded cross-origin.
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(clean);
}

/** A store photo on local disk, under `<uploadBase>/items/<store>/<file>`. */
export async function readLocalStorePhoto(uploadBase: string, vendorId: string, file: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | null> {
  const abs = path.join(uploadBase, STORE_PHOTO_FOLDER, vendorId, file);
  try {
    const s = await stat(abs);
    if (!s.isFile() || s.size > maxBytes) return null;
    const bytes = await readFile(abs, { signal });
    return bytes.length > maxBytes ? null : bytes;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

export function registerPublicStorePhotos(app: FastifyInstance) {
  // Chosen once, as the upload routes choose theirs.
  const storage = getStorageProvider();

  app.get<{ Params: { vendorId: string; file: string } }>(
    `/${STORE_PHOTO_FOLDER}/:vendorId/:file`,
    // Its own allowance, separate from the API's: one screen of a store is
    // dozens of photos, and many phones share one address on mobile networks.
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => serveStorePhoto(app, request, reply, {
      vendorId: request.params.vendorId,
      file: request.params.file,
      stored: (vendorId, file) => `${STORE_PHOTO_FOLDER}/${vendorId}/${file}`,
      read: async (vendorId, file, maxBytes, signal) => {
        if (!canReadBounded(storage)) throw new Error('storage provider has no bounded read');
        return storage.getObjectWithin(`${STORE_PHOTO_FOLDER}/${vendorId}/${file}`, maxBytes, signal);
      },
    }),
  );
}
