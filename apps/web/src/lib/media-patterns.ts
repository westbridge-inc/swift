/**
 * [W2b · owner ruling h4: resize on the web server] Which pictures the web
 * server may fetch and resize. Store photos go through /media; avatars and
 * vehicles retain the built-in optimiser. Only Swift's own API origin and
 * public photo paths, never a private upload folder.
 *
 * Pure (no imports), so next.config.ts can read it.
 */
export const PUBLIC_MEDIA_FOLDERS = ['avatars', 'vehicles'] as const;
export const MEDIA_DEVICE_SIZES = [390, 640, 828, 1080, 1200, 1920];
export const MEDIA_IMAGE_SIZES = [48, 64, 96, 128, 160, 256, 320];

export interface MediaPattern {
  protocol: 'http' | 'https';
  hostname: string;
  port: string;
  pathname: string;
}

/**
 * [PUBLIC-PHOTOS] A store's photo kept in object storage is saved as its key
 * ("items/<store>/<file>") and served by the API at that address (apps/api
 * utils/public-store-photos.ts: only that folder, only photos a store still
 * uses). Exactly two segments under it: a store, then a photo.
 */
export const STORE_PHOTO_PATHNAME = /^\/items\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{16}(?:\.[A-Za-z0-9_-]{1,16})?$/;
export const UPLOAD_STORE_PHOTO_PATHNAME = new RegExp(`^/uploads${STORE_PHOTO_PATHNAME.source.slice(1)}`);

export function isStorePhotoPath(path: string): boolean {
  return STORE_PHOTO_PATHNAME.test(path) || UPLOAD_STORE_PHOTO_PATHNAME.test(path);
}

export function mediaRemotePatterns(apiOrigin: string): MediaPattern[] {
  const origin = new URL(apiOrigin);
  const host = {
    protocol: origin.protocol.replace(':', '') as 'http' | 'https',
    hostname: origin.hostname,
    port: origin.port,
  };
  return PUBLIC_MEDIA_FOLDERS.map((folder) => ({ ...host, pathname: `/uploads/${folder}/**` }));
}
