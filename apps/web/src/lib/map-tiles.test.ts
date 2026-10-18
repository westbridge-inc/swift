import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAPTILER_ATTRIBUTION, MAPTILER_KEY_SETTING, mapTileSource, mapTilesBuildCheck, resolveMapTileSource, usableMapTilerKey,
} from './map-tiles';
import { TEST_MAPTILER_KEY } from '@/test/map-tiles-fixture';

// ---------------------------------------------------------------------------
// [WEB-TILES · owner ruling 14 Oct, #5] The website's map tiles come from ONE
// place. A release uses MapTiler with the owner's public, domain-restricted
// browser key; OpenStreetMap's own tile servers are for `next dev` only, and a
// built site without a usable key draws no tiles at all — never a silent
// fallback to OpenStreetMap.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllEnvs(); });

const KEY = 'abcdabcdabcdabcd';

describe('[WEB-TILES] the tile source', () => {
  it('with a usable key, every build uses MapTiler 256 px tiles, x wrapped around the world', () => {
    for (const mode of ['production', 'development'] as const) {
      const source = resolveMapTileSource(mode, KEY)!;
      expect(source.provider).toBe('maptiler');
      expect(source.tileUrl(15, 10_000, 15_000)).toBe(`https://api.maptiler.com/maps/streets-v2/256/15/10000/15000.png?key=${KEY}`);
      expect(source.tileUrl(1, -1, 0)).toBe(`https://api.maptiler.com/maps/streets-v2/256/1/1/0.png?key=${KEY}`);
      expect(source.tileUrl(1, 2, 1)).toBe(`https://api.maptiler.com/maps/streets-v2/256/1/0/1.png?key=${KEY}`);
    }
  });

  it('a production build with no usable key has NO tiles — never OpenStreetMap', () => {
    for (const raw of [undefined, '', '   ', 'short', 'has space inside', 'key&style=other', 'a/b/c/d/e/f', 'k'.repeat(129), `${KEY}#x`]) {
      expect(resolveMapTileSource('production', raw), String(raw)).toBeNull();
    }
  });

  it('only `next dev` falls back to OpenStreetMap, and only when no key is set', () => {
    const source = resolveMapTileSource('development', undefined)!;
    expect(source.provider).toBe('openstreetmap-dev');
    expect(source.tileUrl(15, -1, 7)).toBe(`https://tile.openstreetmap.org/15/${2 ** 15 - 1}/7.png`);
  });

  it('trims a pasted key and refuses anything that could reshape the tile address', () => {
    expect(usableMapTilerKey(` ${KEY}\n`)).toBe(KEY);
    expect(usableMapTilerKey('get_your_own-key_01')).toBe('get_your_own-key_01');
    for (const bad of ['', 'abc', 'abc def ghi', 'abcdefgh?x=1', 'abcdefgh&x=1', 'abcdefgh/..', 'abcdefgh%2F']) {
      expect(usableMapTilerKey(bad), bad).toBeNull();
    }
  });

  it('this build reads the setting at render: the test build has MapTiler tiles; without the key it has none', () => {
    expect(MAPTILER_KEY_SETTING).toBe('NEXT_PUBLIC_MAPTILER_KEY');
    expect(mapTileSource()?.tileUrl(15, 1, 2)).toBe(`https://api.maptiler.com/maps/streets-v2/256/15/1/2.png?key=${TEST_MAPTILER_KEY}`);
    vi.stubEnv('NEXT_PUBLIC_MAPTILER_KEY', '');
    expect(mapTileSource()).toBeNull();
    vi.stubEnv('NODE_ENV', 'development');
    expect(mapTileSource()?.provider).toBe('openstreetmap-dev');
  });

  it('credits MapTiler and OpenStreetMap contributors in the exact words', () => {
    expect(MAPTILER_ATTRIBUTION).toBe('© MapTiler © OpenStreetMap contributors');
  });
});

describe('[WEB-TILES] the build check (next.config)', () => {
  it('a production build without the key warns that it has no map tiles; development is quiet', () => {
    expect(mapTilesBuildCheck('production', undefined).warning).toMatch(/NEXT_PUBLIC_MAPTILER_KEY is not set: this web build draws NO map tiles/);
    expect(mapTilesBuildCheck('production', '  ').warning).toMatch(/draws NO map tiles/);
    expect(mapTilesBuildCheck('development', undefined).warning).toBeNull();
    expect(mapTilesBuildCheck('production', KEY).warning).toBeNull();
  });

  it('a key that is set but malformed fails the build, in every mode, without printing it', () => {
    for (const mode of ['production', 'development'] as const) {
      expect(() => mapTilesBuildCheck(mode, 'https://api.maptiler.com/x?key=abc')).toThrow(/is set but is not a MapTiler key/);
      let message = '';
      try { mapTilesBuildCheck(mode, 'secretish value'); } catch (error) { message = String(error); }
      expect(message).toMatch(/is set but is not a MapTiler key/);
      expect(message).not.toContain('secretish');
    }
  });
});

// The source contract: one helper, three maps, no copies.
const WEB_ROOT = process.cwd();
function siteSources(directory = join(WEB_ROOT, 'src'), out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { if (name !== 'test') siteSources(path, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}
const rel = (path: string) => relative(WEB_ROOT, path).split(sep).join('/');
const MAPS = ['src/components/tile-map.tsx', 'src/components/pin-picker/pin-picker.tsx', 'src/components/store-location-picker.tsx'];

describe('[WEB-TILES] one tile source, every map', () => {
  it('no site file but the helper names a tile host', () => {
    const naming = siteSources().filter((path) => /tile\.openstreetmap\.org|api\.maptiler\.com/.test(readFileSync(path, 'utf8'))).map(rel);
    expect(naming).toEqual(['src/lib/map-tiles.ts']);
  });

  it('each map draws its tiles from the helper and credits them with the shared attribution', () => {
    for (const path of MAPS) {
      const text = readFileSync(join(WEB_ROOT, path), 'utf8');
      expect(text, path).toMatch(/from '@\/lib\/map-tiles'/);
      expect(text, path).toContain('mapTileSource()');
      expect(text, path).toMatch(/<MapAttribution\b/);
      expect(text, path).not.toContain('OpenStreetMap contributors');
    }
  });

  it('the setting is read in exactly one site file, and next.config checks it at build time', () => {
    const readers = siteSources().filter((path) => readFileSync(path, 'utf8').includes('process.env.NEXT_PUBLIC_MAPTILER_KEY')).map(rel);
    expect(readers).toEqual(['src/lib/map-tiles.ts']);
    const config = readFileSync(join(WEB_ROOT, 'next.config.ts'), 'utf8');
    expect(config).toMatch(/mapTilesBuildCheck\(browserApiMode, process\.env\['NEXT_PUBLIC_MAPTILER_KEY'\]\)/);
  });
});
