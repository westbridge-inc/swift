import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { PUBLIC_MEDIA_FOLDERS, STORE_PHOTO_PATHNAME } from '@/lib/media-patterns';

/**
 * [W2b] Where a photo lives, and whether the web server may resize it.
 *
 * Stores' photos are saved by the API as a path ("/uploads/items/…" on local
 * disk, "items/<store>/<file>" in object storage), not a full address. The phone app has always put the API's origin in front
 * (apps/mobile lib/images.ts mediaUrl); the website used the bare path, which
 * points at the website itself and draws nothing. Same rule here.
 *
 * A photo on the API's own public folders is resized by the web server's image
 * optimiser (sized for the screen, WebP, cached). Anything else — another
 * host, a local preview — is drawn as it is, never handed to the optimiser.
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
    if (parsed.pathname.includes('..')) return false;
    return PUBLIC_MEDIA_FOLDERS.some((folder) => parsed.pathname.startsWith(`/uploads/${folder}/`)) || STORE_PHOTO_PATHNAME.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** What next/image needs for a stored photo: its full address, and whether to leave it as it is. */
export function photo(url: string | null | undefined, apiOrigin: string = BROWSER_API_ORIGIN): { src: string; unoptimized: boolean } | null {
  const src = mediaUrl(url, apiOrigin);
  return src ? { src, unoptimized: !optimizable(src, apiOrigin) } : null;
}
