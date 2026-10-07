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

export function mediaRemotePatterns(apiOrigin: string): MediaPattern[] {
  const origin = new URL(apiOrigin);
  return PUBLIC_MEDIA_FOLDERS.map((folder) => ({
    protocol: origin.protocol.replace(':', '') as 'http' | 'https',
    hostname: origin.hostname,
    port: origin.port,
    pathname: `/uploads/${folder}/**`,
  }));
}
