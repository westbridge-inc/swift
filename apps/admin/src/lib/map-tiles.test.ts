import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAPTILER_KEY_SETTING, MAP_TILES_NOT_CONFIGURED, mapTilesBuildCheck, opsMapTiles, resolveMapTiles, usableMapTilerKey,
} from './map-tiles';

// ---------------------------------------------------------------------------
// [ADMIN-TILES · owner ruling 14 Oct #5, as the website] The Live Ops map's
// tiles come from ONE place. A built console uses MapTiler's OpenStreetMap
// raster tiles with the owner's public, origin-restricted browser key (the
// build setting NEXT_PUBLIC_MAPTILER_KEY). `next dev` without a key uses
// OpenStreetMap's tiles; any other build without a key draws NO tiles and
// says so. Never CARTO (its basemaps now answer every tile with an
// "API KEY REQUIRED" picture), never OpenStreetMap's servers from a build.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllEnvs(); });

const KEY = 'abcdabcdabcdabcd';
const MAPTILER = 'https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png';

describe('[ADMIN-TILES] the Live Ops tile source', () => {
  it('with a usable key, every build uses MapTiler 256 px tiles and credits MapTiler and OpenStreetMap', () => {
    for (const mode of ['production', 'development'] as const) {
      const tiles = resolveMapTiles(mode, KEY)!;
      expect(tiles.provider).toBe('maptiler');
      expect(tiles.url).toBe(`${MAPTILER}?key=${KEY}`);
      expect(tiles.attribution).toMatch(/MapTiler/);
      expect(tiles.attribution).toMatch(/OpenStreetMap/);
    }
  });

  it('a production build with no usable key has NO tiles — never OpenStreetMap, never CARTO', () => {
    for (const raw of [undefined, '', '   ', 'short', 'has space inside', 'key&style=other', 'a/b/c/d/e/f', 'k'.repeat(129), `${KEY}#x`]) {
      expect(resolveMapTiles('production', raw), String(raw)).toBeNull();
    }
  });

  it('only `next dev` falls back to OpenStreetMap, and only when no key is set', () => {
    const tiles = resolveMapTiles('development', undefined)!;
    expect(tiles.provider).toBe('openstreetmap-dev');
    expect(tiles.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(tiles.attribution).toMatch(/OpenStreetMap/);
  });

  it('trims a pasted key and refuses anything that could reshape the tile address', () => {
    expect(usableMapTilerKey(` ${KEY}\n`)).toBe(KEY);
    for (const bad of ['', 'abc', 'abc def ghi', 'abcdefgh?x=1', 'abcdefgh&x=1', 'abcdefgh/..', 'abcdefgh%2F']) {
      expect(usableMapTilerKey(bad), bad).toBeNull();
    }
  });

  it('this build reads the setting at render: key -> MapTiler; none in a build -> no tiles; none in dev -> OpenStreetMap', () => {
    expect(MAPTILER_KEY_SETTING).toBe('NEXT_PUBLIC_MAPTILER_KEY');
    vi.stubEnv('NEXT_PUBLIC_MAPTILER_KEY', KEY);
    expect(opsMapTiles()?.url).toBe(`${MAPTILER}?key=${KEY}`);
    vi.stubEnv('NEXT_PUBLIC_MAPTILER_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(opsMapTiles()).toBeNull();
    vi.stubEnv('NODE_ENV', 'development');
    expect(opsMapTiles()?.provider).toBe('openstreetmap-dev');
  });

  it('the build check refuses a malformed key and warns when a production build has none', () => {
    expect(() => mapTilesBuildCheck('production', 'has space inside')).toThrow(/NEXT_PUBLIC_MAPTILER_KEY/);
    expect(mapTilesBuildCheck('production', undefined).warning).toMatch(/NO map tiles/);
    expect(mapTilesBuildCheck('production', KEY).warning).toBeNull();
    expect(mapTilesBuildCheck('development', undefined).warning).toBeNull();
  });

  it('the missing-tiles note is plain words an operator can act on', () => {
    expect(MAP_TILES_NOT_CONFIGURED).toMatch(/not configured/i);
  });
});

// Every tile address lives in map-tiles.ts: no component builds one, and no
// CARTO address survives anywhere in the console.
describe('[ADMIN-TILES] one place for tile addresses', () => {
  const SRC = join(__dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

  it('no source file outside map-tiles.ts names a tile host', () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(join('lib', 'map-tiles.ts')))
      .filter((f) => /cartocdn|basemaps\.carto|tile\.openstreetmap\.org|api\.maptiler\.com/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the Live Ops map takes its tiles from opsMapTiles()', () => {
    const map = readFileSync(join(SRC, 'components', 'ops', 'OpsMap.tsx'), 'utf8');
    expect(map).toMatch(/opsMapTiles\(\)/);
    expect(map).toMatch(/MAP_TILES_NOT_CONFIGURED/);
  });
});
