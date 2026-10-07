import type { FastifyInstance } from 'fastify';
import { canReadBounded, getStorageProvider } from '../providers/storage/storage-provider';
import { runAsSystem } from '../plugins/tenant-context';
import { imageContentType } from './images';

// ---------------------------------------------------------------------------
// [PUBLIC-PHOTOS] Stores' own photos, whatever the storage provider.
//
// A store's menu photo upload (vendor.routes POST /items/:id/image) saves what
// the storage provider returns. The local provider returns a public path
// ("/uploads/items/<store>/<file>", served by public-uploads.ts). The object
// storage provider used on every managed runtime returns the bare object KEY
// ("items/<store>/<file>") of a PRIVATE bucket, and nothing answered for it:
// every client puts the API origin in front of a value that is not a full
// address (the phone app's mediaUrl, the website's mediaUrl), so they asked
// for "<api>/items/<store>/<file>" and drew a broken photo.
//
// This answers exactly that address, so stored values keep their shape and
// every installed app shows the photo with no client change. It serves:
//   - ONLY the stores' photo folder `items/` — the one folder only the menu
//     photo upload writes, and only after the bytes passed the image sniff.
//     Identity documents, selfies, proof photos, chat and every other upload
//     live in other folders, which are not routed here at all;
//   - ONLY a photo the store that owns the folder still uses: a menu item, a
//     menu section, the store's logo or cover. A replaced photo stops being
//     served, and a key typed into another store's field publishes nothing;
//   - ONLY real JPEG/PNG/WebP bytes within the upload size limit, typed from
//     the bytes themselves, with a long cache (each upload gets a new name, so
//     a name never changes content).
// ---------------------------------------------------------------------------

/** The stores' photo folder (vendor.routes: `items/${vendorId}`). */
export const STORE_PHOTO_FOLDER = 'items';
/** The upload ceiling (app.ts multipart fileSize): nothing larger was ever accepted. */
export const STORE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** A store id: the folder name the upload route writes. No dots, no separators. */
const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** createOpaqueStorageName: 16 random characters, then the uploaded file's extension. */
const PHOTO_NAME = /^[A-Za-z0-9_-]{16}(?:\.[A-Za-z0-9]{1,10})?$/;

const ONE_YEAR = 'public, max-age=31536000, immutable';

/** True while the store that owns the folder shows this exact photo somewhere. */
async function storeShowsPhoto(app: FastifyInstance, vendorId: string, key: string): Promise<boolean> {
  // A guest asks, so no tenant is bound; this names itself instead. It reads
  // one store's own rows by id and answers yes or no — nothing else leaves.
  return runAsSystem('public-store-photo', async () => {
    if (await app.prisma.item.findFirst({ where: { vendorId, imageUrl: key }, select: { id: true } })) return true;
    if (await app.prisma.category.findFirst({ where: { vendorId, imageUrl: key }, select: { id: true } })) return true;
    const store = await app.prisma.vendor.findFirst({
      where: { id: vendorId, OR: [{ coverImageUrl: key }, { logoUrl: key }] },
      select: { id: true },
    });
    return store !== null;
  });
}

export function registerPublicStorePhotos(app: FastifyInstance) {
  // Chosen once, as the upload routes choose theirs.
  const storage = getStorageProvider();

  app.get<{ Params: { vendorId: string; file: string } }>(
    `/${STORE_PHOTO_FOLDER}/:vendorId/:file`,
    // Its own allowance, separate from the API's: one screen of a store is
    // dozens of photos, and many phones share one address on mobile networks.
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { vendorId, file } = request.params;
      const notServed = () => reply.code(404).header('Cache-Control', 'no-store').send();
      if (!STORE_ID.test(vendorId) || !PHOTO_NAME.test(file)) return notServed();

      const key = `${STORE_PHOTO_FOLDER}/${vendorId}/${file}`;
      if (!(await storeShowsPhoto(app, vendorId, key))) return notServed();

      let bytes: Buffer | null;
      try {
        if (!canReadBounded(storage)) throw new Error('storage provider has no bounded read');
        bytes = await storage.getObjectWithin(key, STORE_PHOTO_MAX_BYTES);
      } catch (err) {
        request.log.error({ err }, '[PUBLIC-PHOTOS] storage read failed');
        return reply.code(503).header('Cache-Control', 'no-store').send();
      }
      const type = bytes ? imageContentType(bytes) : null;
      if (!bytes || !type) return notServed();

      return reply
        .header('Content-Type', type)
        .header('Cache-Control', ONE_YEAR)
        .header('X-Content-Type-Options', 'nosniff')
        // The website draws these from another origin (its own pages and its
        // image optimiser), so the photo may be embedded cross-origin.
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .send(bytes);
    },
  );
}
