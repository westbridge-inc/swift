// Universal Links association [QR deep-links, qr spec Part 6]: iOS fetches
// this (via Apple's CDN) at install/update; matching paths then open the app
// instead of Safari.
//
// The Team ID now DEFAULTS instead of 404ing, for the same reason the bundle
// id does. The original rule — "404 until APPLE_TEAM_ID is provided, an honest
// absence, never a fake association" — was guarding against publishing an
// association for an app that is not ours. A real Team ID is not that. And the
// cost of the strict version was paid in full: the file 404'd in every
// environment that has ever existed, so every printed QR code and every shared
// storefront link opened Safari on a phone that had Swift installed, and
// nothing anywhere reported it.
//
// A Team ID is not a secret. It is PUBLISHED, by design, in this very file at
// a well-known public URL, and it authorises nothing on its own — signing
// requires private certificates that live only in the Apple account. Hard-coding
// it removes a deploy-time footgun and costs no confidentiality.
//
// The env var still wins, so a fork or a second Apple account can override it.

export const dynamic = 'force-dynamic';

/** Swift's Apple Developer Team ID (Westbridge Inc). Public by design. */
const TEAM_ID = process.env['APPLE_TEAM_ID'] ?? 'N3JV22LC84';
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
