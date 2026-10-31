import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { SITE_DOMAIN } from './src/site.domain';
import { MEDIA_DEVICE_SIZES, MEDIA_IMAGE_SIZES, mediaRemotePatterns } from './src/lib/media-patterns';

/** The public site's own names: never noindexed, whichever build answers them. */
const PUBLIC_SITE_HOSTS = [SITE_DOMAIN, `www.${SITE_DOMAIN}`];
import {
  type BrowserApiMode,
  buildBrowserContentSecurityPolicy,
  resolveConfiguredBrowserApiOrigin,
  resolveConfiguredReleaseChannel,
} from './src/lib/browser-api-origin';
import { mapTilesBuildCheck } from './src/lib/map-tiles';

// The public face of Swift — marketing + (coming) customer web + operator
// dashboards. Same hardening posture as the admin console.

/** [PERF #7] How long a browser keeps a self-hosted font file (see headers()). */
const FONT_CACHE_CONTROL = 'public, max-age=2592000, stale-while-revalidate=604800';

// [SWX-DEV-WEB-076 · integrated] The browser API origin and the CSP that
// permits exactly it come from ONE authority (src/lib/browser-api-origin.ts).
// `next dev` runs in development mode; every other phase — build, start,
// export — is production and REQUIRES one of the channel's exact origins
// (production: the release origin or the pre-launch origin; staging: staging).
export default function createNextConfig(phase: string): NextConfig {
  // `next lint` loads this config with the production-build phase but produces
  // no artifact; the release law binds artifacts, so linting runs as
  // development. `next build`, `next start` and `next export` do not.
  const linting = process.argv.includes('lint');
  const browserApiMode: BrowserApiMode = phase === PHASE_DEVELOPMENT_SERVER || linting ? 'development' : 'production';
  // [Q11] Which API a release build is for: the public API unless the build
  // declares the staging channel (the self-hosted staging image does).
  const releaseChannel = resolveConfiguredReleaseChannel();
  const browserApiOrigin = resolveConfiguredBrowserApiOrigin(browserApiMode, releaseChannel);
  // [CARD embed] The bank's card page shown inside the weekly-fee page (an iframe of the
  // API's own card page). OFF unless the build sets SWIFT_WEB_CARD_FRAME=1: off, the CSP and
  // the client bundle are exactly what they were, and the card page opens in the same tab.
  const cardFrame = process.env['SWIFT_WEB_CARD_FRAME'] === '1';
  // [OPEN-EARLY] The policy names the origin the build resolved (the release origin or the
  // pre-launch one), so the browser may connect to exactly the API this build calls.
  const csp = buildBrowserContentSecurityPolicy(browserApiMode, releaseChannel, { cardFrame, apiOrigin: browserApiOrigin });
  // [WEB-TILES] The MapTiler browser key (lib/map-tiles.ts): a malformed value
  // refuses the build; a production build without one says, in its log, that
  // the site it builds draws no map tiles. Next inlines the key into the bundle.
  const mapTiles = mapTilesBuildCheck(browserApiMode, process.env['NEXT_PUBLIC_MAPTILER_KEY']);
  if (mapTiles.warning) console.warn(`[web build] ${mapTiles.warning}`);

  // [Q11] apps/web/Dockerfile sets SWIFT_WEB_IMAGE_BUILD=1, and nothing else
  // does: Vercel and CI get exactly the config they had. The image runs Next's
  // standalone server. Its build context carries this app and the shared
  // packages but not the other apps' dependencies, which the site's type graph
  // reaches (lib/design-tokens -> the mobile kit's pictograms -> react-native-svg;
  // scripts/sync-legal -> the API's Fastify routes), so the type check and lint
  // stay where they already run on the full workspace: CI's lint, type-check
  // and Web Build jobs, which every main commit passed, and deploy/pilot-up.sh
  // builds only main commits.
  const imageBuild = process.env['SWIFT_WEB_IMAGE_BUILD'] === '1';
  const imageBuildConfig: Pick<NextConfig, 'output' | 'typescript' | 'eslint'> = imageBuild
    ? { output: 'standalone', typescript: { ignoreBuildErrors: true }, eslint: { ignoreDuringBuilds: true } }
    : {};

  return {
    poweredByHeader: false,
    // [M013] Request targets and upstream fetch URLs carry private grants:
    // share and tracking tokens in the path (/trip/<token>, /track/<token>),
    // MMG replies (/pay/mmg/...) and signed upstream URLs. `false` turns off
    // Next's whole development request and fetch logger, not a list of paths
    // that a new private route could miss. (Next prints no request log in
    // production; the API keeps its own redacted diagnostics.)
    logging: false,
    ...imageBuildConfig,
    // @swift/types ships TypeScript source; Next must transpile it (the admin
    // console declares the same). The site reads the market zone from it.
    transpilePackages: ['@swift/types'],
    // [Size budget, PERF 21 Oct] The customer app's shared code in ONE chunk. Next's default
    // splitting only makes a shared chunk of 20 kB or more, so the small modules many customer
    // pages share (the session context, the basket state, the chunk-retry helper, the shell's
    // icons, skeletons and routes) were copied into each page's own chunk as well as the
    // layout's: 2.5 to 4.5 kB loaded twice on every customer page. This group puts the app's own
    // code (and lucide's icons) that at least 12 of the customer pages use into one chunk they all
    // load (and, second group, what the layout shares with any customer page). Customer pages only
    // (app/(app)/...); the partner consoles, sign-in and legal pages keep
    // Next's defaults. JavaScript only: CSS keeps Next's own chunking and order.
    webpack: (config, { isServer }) => {
      if (isServer) return config;
      const splitChunks = config.optimization?.splitChunks;
      if (!splitChunks || typeof splitChunks !== 'object') return config;
      const appOwnCode = /[\\/](src[\\/]|lucide-react[\\/])/;
      type ChunkModule = { type?: string; nameForCondition?: () => string | null };
      const customerChunk = (chunk: { name?: string | null }) => /^app\/\(app\)\//.test(chunk.name ?? '');
      const appOwnJs = (module: ChunkModule) => !module.type?.startsWith('css') && appOwnCode.test(module.nameForCondition?.() ?? '');
      splitChunks.cacheGroups = {
        ...(splitChunks.cacheGroups ?? {}),
        customerAppShared: {
          name: 'customer-app-shared',
          chunks: customerChunk,
          test: appOwnJs,
          minChunks: 12,
          minSize: 0,
          priority: 25,
          reuseExistingChunk: true,
        },
        // [Size budget, CI perf #2222] The same copy, from the layout's side: a module the customer
        // layout loads AND fewer than 12 customer pages load too (the chunk-retry helper, the shell's
        // person and basket state, the Home feed check) was still in the layout's chunk and again in
        // each of those pages' own chunks: about 1.5 kB twice on Home, 1 kB on a store page. The
        // layout always loads customer-app-shared, so moving such a module there costs no page
        // anything and loads it once.
        customerAppLayoutShared: {
          name: 'customer-app-shared',
          chunks: customerChunk,
          test: (module: ChunkModule, context?: { chunkGraph?: { getModuleChunksIterable: (_m: unknown) => Iterable<{ name?: string | null }> } }) =>
            appOwnJs(module)
            && [...(context?.chunkGraph?.getModuleChunksIterable(module) ?? [])].some((chunk) => chunk.name === 'app/(app)/layout'),
          minChunks: 2,
          minSize: 0,
          priority: 24,
          reuseExistingChunk: true,
        },
        // [WEBSITE 30 Oct · size budget] The same, for the public site's pages (app/(marketing)/...): a module the
        // marketing layout loads (the footer's store links and the launch switch's one question to the server) and
        // a page loads too was copied into that page's own chunk. One chunk the layout always loads holds it
        // instead, so no marketing page downloads it twice. Pages outside (marketing) keep their chunking.
        marketingLayoutShared: {
          name: 'marketing-shared',
          chunks: (chunk: { name?: string | null }) => /^app\/\(marketing\)\//.test(chunk.name ?? ''),
          test: (module: ChunkModule, context?: { chunkGraph?: { getModuleChunksIterable: (_m: unknown) => Iterable<{ name?: string | null }> } }) =>
            appOwnJs(module)
            && [...(context?.chunkGraph?.getModuleChunksIterable(module) ?? [])].some((chunk) => chunk.name === 'app/(marketing)/layout'),
          minChunks: 2,
          minSize: 0,
          priority: 23,
          reuseExistingChunk: true,
        },
      };
      return config;
    },
    // The exact origin is inlined into every client chunk from the authority,
    // so no consumer can fall back to localhost in a release by accident.
    env: {
      NEXT_PUBLIC_API_URL: browserApiOrigin,
      ...(cardFrame ? { NEXT_PUBLIC_CARD_FRAME: '1' } : {}),
    },
    // Store photos bypass Next's stale-on-error image cache via photo() and
    // /media. The one-year minimum below applies ONLY to avatars and vehicles.
    // Both resize routes share the same responsive width lists and WebP format.
    images: {
      remotePatterns: mediaRemotePatterns(browserApiOrigin),
      // Do not let /_next/image wrap /media and revive its stale-on-error cache.
      localPatterns: [{ pathname: '/icons/**' }, { pathname: '/_next/static/media/**' }],
      formats: ['image/webp'],
      minimumCacheTTL: 60 * 60 * 24 * 365,
      deviceSizes: MEDIA_DEVICE_SIZES,
      imageSizes: MEDIA_IMAGE_SIZES,
      dangerouslyAllowSVG: false,
    },
    // App Router ignores dot-prefixed folders, so the OS association files are
    // route handlers under /well-known/* surfaced at their mandated paths here.

    // [SITE-1.1 Part 2 / AC-13] The route names the spec mandates, without
    // breaking a single link that already exists in the wild — every former
    // path 301s to its replacement. 301 rather than 302 so search engines and
    // any printed material transfer their authority to the new URL.
    async redirects() {
      return [
        { source: '/for-vendors', destination: '/vendors', permanent: true },
        { source: '/for-drivers', destination: '/drivers', permanent: true },
        { source: '/delete-account', destination: '/account/delete', permanent: true },
        // [AC-12] Canonical host is the apex. www 301s to it, so every share
        // link resolves on exactly one origin.
        //
        // ...except the two association files, which must NOT redirect.
        //
        // Apple's AASA fetcher and Android's App Links verifier both refuse to
        // follow redirects, and the app claims BOTH hosts —
        // `applinks:www.<domain>` in associatedDomains, and a www intent filter
        // for /s and /store. With the rule below unscoped, iOS and Android
        // fetched the association from www, got a 301, and silently failed to
        // verify it. The apex kept working, so nothing looked broken; a www
        // link just opened a browser tab on a phone that had Swift installed —
        // which is the exact failure universal links exist to prevent, hiding
        // inside the redirect that was added to tidy the origins.
        //
        // The original comment said the rule "never touches the apex", which
        // was true and was the wrong half to worry about.
        {
          source: '/:path((?!\\.well-known/).*)',
          has: [{ type: 'host', value: `www.${SITE_DOMAIN}` }],
          destination: `https://${SITE_DOMAIN}/:path*`,
          permanent: true,
        },
      ];
    },

    async rewrites() {
      const api = browserApiOrigin;
      return [
        { source: '/.well-known/apple-app-site-association', destination: '/well-known/apple-app-site-association' },
        { source: '/.well-known/assetlinks.json', destination: '/well-known/assetlinks.json' },
        // The printed QR URL is {APP_PUBLIC_URL}/s/{code}; the web domain
        // proxies it to the API's public resolver (302 passes through). Only
        // wired when the build knows its API — dev keeps the route local.
        { source: '/s/:code', destination: `${api}/s/:code` },
      ];
    },
    async headers() {
      return [
        {
          // [AX303 F3] The QR resolver records scans on GET. robots.txt keeps
          // compliant crawlers away; this response header also marks the
          // proxied redirect noindex. Next applies headers before rewrites.
          source: '/s/:path*',
          headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
        },
        {
          // [AC-11] Apple fetches this via its CDN and requires application/json
          // with no redirect. The route handler already returns JSON; this pins
          // the content type at the edge and keeps the file out of any cache
          // that might outlive a Team ID change.
          source: '/.well-known/apple-app-site-association',
          headers: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Cache-Control', value: 'public, max-age=3600' },
          ],
        },
        {
          source: '/.well-known/assetlinks.json',
          headers: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Cache-Control', value: 'public, max-age=3600' },
          ],
        },
        {
          // [PERF #7] The self-hosted font files (public/fonts) used to go out
          // with Next's default for public files, `max-age=0`, so every full
          // page load (each QR scan) asked again about every face it used
          // before it could draw text in it. They are kept for 30 days now
          // (then used while re-checked in the background). Their names carry
          // no version: a changed font must take a NEW file name.
          source: '/fonts/:file',
          headers: [{ key: 'Cache-Control', value: FONT_CACHE_CONTROL }],
        },
        {
          // [PWA-1] The service worker (public/sw.js). Never cached, so a fixed
          // worker reaches phones on their next visit rather than when a cache
          // expires; the type is pinned because a browser refuses to install a
          // worker served as anything but JavaScript. No Service-Worker-Allowed
          // header: the script sits at the root, so its scope is already the
          // whole site. The site-wide policy below (CSP included) applies to it
          // as to every response — the worker only fetches same-origin, which
          // connect-src 'self' already permits.
          source: '/sw.js',
          headers: [
            { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
            { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          ],
        },
        {
          source: '/(.*)',
          headers: [
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
            { key: 'Content-Security-Policy', value: csp },
            // [SITE-1.1 Part 6.3] Two years, subdomains included, preload-eligible.
            // Matches the admin console's posture; the site is the company's
            // public identity and is only ever served over TLS.
            { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
            // [SITE-1.1 Part 6.3] An EMPTY allowlist — `camera=()` — disables the
            // feature for every origin INCLUDING self. This site genuinely uses two
            // of them: /selfie captures a KYC selfie via getUserMedia, and the taxi,
            // courier, order-location and signup flows read a pickup point through
            // lib/geolocate.ts. Locking those to `()` does not harden anything; it
            // silently breaks the product, and it breaks it in the browser rather
            // than at build time, so nothing here would catch it.
            // `(self)` is the correct posture: same-origin may ask, and the user is
            // still prompted. Third parties and embeds get nothing. Microphone stays
            // fully off — no surface on this site records audio.
            // permissions-policy.test.ts enforces this against the real source tree.
            {
              key: 'Permissions-Policy',
              value: 'geolocation=(self), microphone=(), camera=(self)',
            },
          ],
        },
        // [Q11] The staging site is a full copy of the public one on another
        // host, backed by test data: no search engine may index it in the
        // public site's place. A staging-channel build only; the public build
        // never sends this. [DS628] And only on the staging host(s): the deploy
        // stack can serve the public names from this same image
        // (WEB_ALIAS_HOSTS), and swiftgy.com and www must stay indexable. Every
        // other name keeps the noindex, so an unexpected host fails safe.
        ...(releaseChannel === 'staging'
          ? [{
              source: '/(.*)',
              missing: PUBLIC_SITE_HOSTS.map((host) => ({ type: 'host' as const, value: host.replace(/\./g, '\\.') })),
              headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
            }]
          : []),
        // Every depth: MMG may put its reply in the path (/pay/mmg/success/token=…).
        // These rules come after the site-wide ones, so they win for these paths
        // (Referrer-Policy included), and Next sends a config header in place of
        // the route handler's own.
        // [M053] The public trip and parcel pages carry a bearer token in their
        // path: nothing they load or link to is told the page's address.
        { source: '/trip/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
        { source: '/track/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
        { source: '/pay/mmg/:path*', headers: [
          { key: 'X-Robots-Tag', value: 'noindex' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ] },
      ];
    },
  };
}
