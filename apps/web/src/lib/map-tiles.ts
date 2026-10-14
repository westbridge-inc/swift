// ---------------------------------------------------------------------------
// [WEB-TILES · owner ruling 14 Oct, #5] WHERE THE WEBSITE'S MAP TILES COME FROM.
//
// ONE place. Every map on the site (the tracking/trip map, the customer pin
// picker, the store-entrance picker) asks `mapTileSource()` for its tiles and
// draws `<MapAttribution>` under them; no component builds a tile address.
//
// Production: MapTiler's hosted OpenStreetMap-based raster tiles. OpenStreetMap's
// own tile servers are a community service whose usage policy rules out a
// production site's traffic, so a release never requests them.
//
// The key is the build setting NEXT_PUBLIC_MAPTILER_KEY. Next inlines it into
// the browser bundle at build time, so it is PUBLIC by construction: it is the
// owner's MapTiler browser key, restricted in MapTiler to the site's own
// origins (each tile request sends the site's origin as its Referer, never the
// page's path). It is never written in this repository.
//
// No usable key:
//   - `next dev`: OpenStreetMap's tiles, so local work still shows a map;
//   - every other build (CI, staging, production): NO tiles. The map says so,
//     and neither picker can confirm a pin on it (they accept a pin only once
//     every visible tile has loaded).
// Why "no tiles" and not "fail the build": CI and the staging image build the
// site without the owner's key, and an unrelated urgent website fix must never
// wait on it. A map with no tiles is visible to anyone who opens it — never a
// silent fallback — and it sends nothing to OpenStreetMap's servers. A
// production build without the key also warns in its build log (next.config).
// ---------------------------------------------------------------------------

export const MAPTILER_KEY_SETTING = 'NEXT_PUBLIC_MAPTILER_KEY';

/** MapTiler's raster tiles: 256 px, Web Mercator, OpenStreetMap data. */
const MAPTILER_TILES = 'https://api.maptiler.com/maps/streets-v2/256';
/** Development only (`next dev`): never requested by a built site. */
const OSM_DEV_TILES = 'https://tile.openstreetmap.org';

/** A key is letters, digits, '-' or '_': nothing that could reshape the tile address. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

export type MapTileMode = 'development' | 'production';
export type MapTileProvider = 'maptiler' | 'openstreetmap-dev';

export interface MapTileSource {
  readonly provider: MapTileProvider;
  /** The tile at this zoom and grid cell; x wraps around the world. */
  tileUrl(_zoom: number, _x: number, _y: number): string;
}

function wrap(zoom: number, x: number): number {
  const count = 2 ** zoom;
  return ((x % count) + count) % count;
}

/** The configured key, trimmed, when it has a key's shape; otherwise null. */
export function usableMapTilerKey(raw: string | undefined): string | null {
  const key = raw?.trim() ?? '';
  return KEY_SHAPE.test(key) ? key : null;
}

/**
 * The tile source for a build of this `mode` with this raw setting. `null`
 * means the build has no tiles: the map shows none and says so.
 */
export function resolveMapTileSource(mode: MapTileMode, rawKey: string | undefined): MapTileSource | null {
  const key = usableMapTilerKey(rawKey);
  if (key) {
    const query = `?key=${encodeURIComponent(key)}`;
    return { provider: 'maptiler', tileUrl: (zoom, x, y) => `${MAPTILER_TILES}/${zoom}/${wrap(zoom, x)}/${y}.png${query}` };
  }
  if (mode === 'development') {
    return { provider: 'openstreetmap-dev', tileUrl: (zoom, x, y) => `${OSM_DEV_TILES}/${zoom}/${wrap(zoom, x)}/${y}.png` };
  }
  return null;
}

/**
 * The tile source THIS build serves. Read at render: Next inlines both names
 * at build time (`next dev` is development; every built site is production).
 */
export function mapTileSource(): MapTileSource | null {
  return resolveMapTileSource(
    process.env.NODE_ENV === 'development' ? 'development' : 'production',
    process.env.NEXT_PUBLIC_MAPTILER_KEY,
  );
}

/**
 * next.config's build-time check. A key that is SET but has no key's shape is
 * an operator's mistake (a stray space inside, a pasted URL): the build refuses
 * it rather than ship a site that the operator believes has a map. A missing
 * key in a production build returns a warning for the build log; the built
 * site then shows no tiles (above). Development needs nothing.
 */
export function mapTilesBuildCheck(mode: MapTileMode, rawKey: string | undefined): { warning: string | null } {
  const set = (rawKey?.trim() ?? '') !== '';
  if (set && !usableMapTilerKey(rawKey)) {
    throw new Error(`${MAPTILER_KEY_SETTING} is set but is not a MapTiler key (letters, digits, '-' or '_' only). Fix the web build setting.`);
  }
  if (!set && mode === 'production') {
    return { warning: `${MAPTILER_KEY_SETTING} is not set: this web build draws NO map tiles, and no pin can be placed on its maps. Set it in the web build environment before a public release.` };
  }
  return { warning: null };
}

/** Every map with MapTiler tiles credits both MapTiler and OpenStreetMap's contributors. */
export const MAPTILER_ATTRIBUTION = '© MapTiler © OpenStreetMap contributors';
/** Development's OpenStreetMap tiles credit OpenStreetMap's contributors. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Shown in place of tiles when a build has none. */
export const MAP_TILES_UNAVAILABLE = 'The map isn’t available on this site yet.';
