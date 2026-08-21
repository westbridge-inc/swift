import { getStorageProvider } from '../providers/storage/storage-provider';

/**
 * [F-024-09] Resolve a stored avatar value into something a client can render.
 *
 * Three shapes live in `users.avatar`:
 *  - absolute http(s) URLs (legacy/dev seeds) — pass through;
 *  - `/uploads/...` paths from the LOCAL provider — public static route,
 *    pass through (clients prefix their API base);
 *  - bare object KEYS from the S3/R2 provider (`avatars/xyz.jpg`) — the
 *    object is PRIVATE, so a client can never fetch the key directly; it must
 *    be exchanged for a short-lived signed GET here at read time. Before this,
 *    production selfies were unrenderable: clients glued the key onto their
 *    API base, which is neither a valid URL nor an authorized read.
 *
 * Signing failures resolve to null (render the monogram) rather than leaking
 * a bare key for the client to mangle.
 */
export async function resolveAvatarUrl(raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null;
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')) return raw;
  try {
    return await getStorageProvider().getSignedUrl(raw, 3600);
  } catch {
    return null;
  }
}
