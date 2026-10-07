import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import type { ImageLoader } from 'next/image';
import { PUBLIC_MEDIA_FOLDERS, isStorePhotoPath } from '@/lib/media-patterns';
import storePhotoLoader from '@/lib/store-photo-loader';

/**
 * [W2b] Where a photo lives, and whether the web server may resize it.
 *
 * Stores' photos are saved by the API as a path ("/uploads/items/…" on local
 * disk, "items/<store>/<file>" in object storage), not a full address. The phone app has always put the API's origin in front
 * (apps/mobile lib/images.ts mediaUrl); the website used the bare path, which
 * points at the website itself and draws nothing. Same rule here.
 *
 * Store photos use our bounded /media route. Avatars and vehicles retain the
 * built-in optimiser. Other hosts and previews are drawn as they are.
 */
export function mediaUrl(url: string | null | undefined, apiOrigin: string = BROWSER_API_ORIGIN): string | null {
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${apiOrigin.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

export function optimizable(url: string, apiOrigin: string = BROWSER_API_ORIGIN): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== new URL(apiOrigin).origin) return false;
    if (parsed.username || parsed.password || /[%\\]|\.\./.test(url)) return false;
    return PUBLIC_MEDIA_FOLDERS.some((folder) => parsed.pathname.startsWith(`/uploads/${folder}/`));
  } catch {
    return false;
  }
}

/** The only gate selecting the store-photo loader; callers keep next/image's sizes and preload behavior. */
export function photo(url: string | null | undefined, apiOrigin: string = BROWSER_API_ORIGIN): { src: string; unoptimized: boolean; loader?: ImageLoader } | null {
  const src = mediaUrl(url, apiOrigin);
  if (!src) return null;
  try {
    const parsed = new URL(src);
    if (parsed.href === src && parsed.origin === new URL(apiOrigin).origin && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && !/[%\\]|\.\./.test(src) && isStorePhotoPath(parsed.pathname)) {
      return { src: `/media${parsed.pathname}`, unoptimized: false, loader: storePhotoLoader };
    }
  } catch { /* A local preview or an invalid address does not enter either store-photo cache. */ }
  return { src, unoptimized: !optimizable(src, apiOrigin) };
}
