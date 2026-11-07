// ---------------------------------------------------------------------------
// [ADMIN-TILES · owner ruling 14 Oct #5, the website's rule applied to the
// console] WHERE THE LIVE OPS MAP'S TILES COME FROM. ONE place: the map asks
// `opsMapTiles()` and never builds a tile address itself.
//
// A built console: MapTiler's hosted OpenStreetMap-based raster tiles, with the
// owner's MapTiler BROWSER key from the build setting NEXT_PUBLIC_MAPTILER_KEY
// (the same key and setting as the website, apps/web/src/lib/map-tiles.ts).
// Next inlines it into the bundle at build time, so it is public by
// construction; MapTiler serves it only to the origins the owner allows (the
// console's own origin among them). It is never written in this repository.
//
// No usable key:
//   - `next dev`: OpenStreetMap's tiles, so local work still shows a map;
//   - every other build: NO tiles, and the map says so in plain words. Never
//     OpenStreetMap's servers (their usage policy rules out a product's
//     traffic) and never CARTO (its basemaps now answer every tile with an
//     "API KEY REQUIRED" picture — the blank map this replaces).
// ---------------------------------------------------------------------------

export const MAPTILER_KEY_SETTING = 'NEXT_PUBLIC_MAPTILER_KEY';

// Next's compiler requires this exact dot-form lookup for static replacement.
/* eslint-disable no-unused-vars */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NEXT_PUBLIC_MAPTILER_KEY?: string;
    }
  }
}
/* eslint-enable no-unused-vars */

/** MapTiler's raster tiles: 256 px, Web Mercator, OpenStreetMap data. Leaflet fills {z}/{x}/{y}. */
const MAPTILER_TILES = 'https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png';
/** Development only (`next dev`): never requested by a built console. */
const OSM_DEV_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const MAPTILER_CREDIT = `&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ${OSM_CREDIT}`;

/** A key is letters, digits, '-' or '_': nothing that could reshape the tile address. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;

export type MapTileMode = 'development' | 'production';

export interface MapTiles {
  readonly provider: 'maptiler' | 'openstreetmap-dev';
  /** A Leaflet tile URL template. */
  readonly url: string;
  /** The credit Leaflet shows under the map (HTML). */
  readonly attribution: string;
}

/** The configured key, trimmed, when it has a key's shape; otherwise null. */
export function usableMapTilerKey(raw: string | undefined): string | null {
  const key = raw?.trim() ?? '';
  return KEY_SHAPE.test(key) ? key : null;
}

/** The tiles for a build of this `mode` with this raw setting; `null` = no tiles (the map says so). */
export function resolveMapTiles(mode: MapTileMode, rawKey: string | undefined): MapTiles | null {
  const key = usableMapTilerKey(rawKey);
  if (key) return { provider: 'maptiler', url: `${MAPTILER_TILES}?key=${encodeURIComponent(key)}`, attribution: MAPTILER_CREDIT };
  if (mode === 'development') return { provider: 'openstreetmap-dev', url: OSM_DEV_TILES, attribution: OSM_CREDIT };
  return null;
}

/** The tiles THIS build serves (`next dev` is development; every built console is production). */
export function opsMapTiles(): MapTiles | null {
  return resolveMapTiles(
    process.env.NODE_ENV === 'development' ? 'development' : 'production',
    process.env.NEXT_PUBLIC_MAPTILER_KEY,
  );
}

/**
 * next.config's build-time check: a key that is SET but has no key's shape is
 * refused (the operator would believe the map works); a production build with
 * no key gets a build-log warning and ships a map that says it has no tiles.
 */
export function mapTilesBuildCheck(mode: MapTileMode, rawKey: string | undefined): { warning: string | null } {
  const set = (rawKey?.trim() ?? '') !== '';
  if (set && !usableMapTilerKey(rawKey)) {
    throw new Error(`${MAPTILER_KEY_SETTING} is set but is not a MapTiler key (letters, digits, '-' or '_' only). Fix the admin build setting.`);
  }
  if (!set && mode === 'production') {
    return { warning: `${MAPTILER_KEY_SETTING} is not set: this admin build draws NO map tiles on Live Ops. Set it in the admin build environment.` };
  }
  return { warning: null };
}

/** Shown on the Live Ops map in place of tiles when a build has none. */
export const MAP_TILES_NOT_CONFIGURED = 'Map tiles are not configured for this console yet. Movers and orders are still listed; the street map needs the MapTiler key in the admin build.';
