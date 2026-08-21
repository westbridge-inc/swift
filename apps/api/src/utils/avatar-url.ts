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

/** List-safe variant. [F-026-01] The single resolver closed one screen but
 *  not the API contract: order lists and cross-user surfaces still emitted
 *  raw private keys. Signing is local computation for both providers — an
 *  HMAC for local storage, a presign for S3/R2 with no network round trip —
 *  so resolving a page of rows is cheap, and identical keys are resolved once.
 */
export async function resolveAvatarUrls(raws: (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(raws.filter((r): r is string => !!r))];
  const out = new Map<string, string | null>();
  await Promise.all(unique.map(async (raw) => { out.set(raw, await resolveAvatarUrl(raw)); }));
  return out;
}
