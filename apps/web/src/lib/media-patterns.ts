/**
 * [W2b · owner ruling h4: resize on the web server] Which pictures the web
 * server's image optimiser may fetch and resize. Only the public photo folders
 * on Swift's own API origin (apps/api utils/public-uploads.ts: menu photos,
 * profile photos, vehicle photos) — never another host, and never a private
 * upload folder (identity documents live elsewhere and are not served here).
 *
 * Pure (no imports), so next.config.ts can read it.
 */
export const PUBLIC_MEDIA_FOLDERS = ['items', 'avatars', 'vehicles'] as const;

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
export const STORE_PHOTO_PATHNAME = /^\/items\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{16}(?:\.[A-Za-z0-9]{1,10})?$/;

export function mediaRemotePatterns(apiOrigin: string): MediaPattern[] {
  const origin = new URL(apiOrigin);
  const host = {
    protocol: origin.protocol.replace(':', '') as 'http' | 'https',
    hostname: origin.hostname,
    port: origin.port,
  };
  return [
    ...PUBLIC_MEDIA_FOLDERS.map((folder) => ({ ...host, pathname: `/uploads/${folder}/**` })),
    { ...host, pathname: '/items/*/*' },
  ];
}
