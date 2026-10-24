import { AppError } from './errors';

/**
 * [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] Photo addresses: which ones customers are
 * handed, and what typed text may do with a photo field.
 *
 * A photo a store uploads is kept by Swift and saved as a path with NO host:
 * "items/<store>/<file>" in object storage, "/uploads/<folder>/<file>" on local disk.
 * Both apps put the API's own origin in front of it, so a customer's phone asks Swift
 * for it and Swift's public photo door decides (utils/public-store-photos.ts).
 *
 * An address that names another host (typed, or imported from a spreadsheet, before
 * photos became upload-only) made every customer's phone load the picture from that
 * host: never scanned, never redrawn without its camera data, no size cap, and every
 * customer's IP address handed to a third party. Such an address is NOT handed to
 * customers any more (null: the apps draw the designed placeholder that names the
 * item) until the store uploads the photo again.
 */

/** A path with no scheme, no host and nothing encoded: one optional leading "/", then
 *  path characters only ("//host", "https:", "data:", "\\host" and "%2F" all fail). */
const KEPT_PHOTO_ADDRESS = /^\/?[A-Za-z0-9_-][A-Za-z0-9_./-]*$/;

/** The address customers are handed for a store's photo: a photo Swift keeps, or null. */
export function servedPhotoAddress(address: string | null | undefined): string | null {
  if (typeof address !== 'string' || address.length > 2048 || !KEPT_PHOTO_ADDRESS.test(address)) return null;
  return address;
}

/**
 * What typed text (an edit form, an API call) may do with a photo the store UPLOADS:
 * '' takes it down (null); sending back the address already there leaves it as it is
 * (a client that echoes the row); undefined leaves it. Anything else (an outside
 * address, another store's key, a path into another folder) is refused: it would skip
 * the scan and the redraw, or point customers at a third party.
 */
export function uploadOnlyPhotoField(
  sent: string | undefined,
  current: string | null | undefined,
  what: string,
): string | null | undefined {
  if (sent === undefined) return undefined;
  if (sent.trim() === '') return null;
  if (sent === (current ?? '')) return undefined;
  throw new AppError(400, 'STORE_PHOTO_UPLOAD_ONLY', `Add ${what} by uploading a photo`);
}

/** The note an imported row gets when it names a photo address: the row is imported
 *  without it, and the store adds the photo by uploading it. */
export const IMPORT_PHOTO_ADDRESS_NOTE =
  'Imported without its photo: a photo address is not used. Add the photo by uploading it in the app or on the website.';
