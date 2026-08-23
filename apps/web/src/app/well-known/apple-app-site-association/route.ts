// Universal Links association [QR deep-links, qr spec Part 6]: iOS fetches
// this (via Apple's CDN) at install/update; matching paths then open the app
// instead of Safari. 404 until APPLE_TEAM_ID is provided — an honest absence,
// never a fake association. Served at /.well-known/apple-app-site-association
// via the rewrite in next.config.ts.

export const dynamic = 'force-dynamic';

const TEAM_ID = process.env['APPLE_TEAM_ID'];
const BUNDLE_ID = process.env['APPLE_BUNDLE_ID'] ?? 'gy.swift.app';

export function GET() {
  if (!TEAM_ID) return new Response(null, { status: 404 });
  const appID = `${TEAM_ID}.${BUNDLE_ID}`;
  return Response.json(
    {
      applinks: {
        apps: [],
        details: [
          {
            // appIDs+components is the modern (iOS 13+) shape; appID+paths
            // kept for older AASA parsers. Both cover the QR short links and
            // the storefront links the app's deep-link router handles.
            appIDs: [appID],
            appID,
            components: [{ '/': '/s/*' }, { '/': '/store/*' }],
            paths: ['/s/*', '/store/*'],
          },
        ],
      },
    },
    { headers: { 'cache-control': 'public, max-age=3600' } },
  );
}
