'use client';

import { useState } from 'react';
import { mapPixel } from '@/lib/store-pin';
import type { Point } from '@/lib/live-tracking';
import { MAP_TILES_UNAVAILABLE, mapTileSource, type MapTileSource } from '@/lib/map-tiles';
import { MapAttribution } from './map-attribution';

/**
 * [W7] A small map drawn from raster map tiles — the same tiles the
 * store-location picker uses, from the one tile source (lib/map-tiles.ts:
 * MapTiler in a release) — instead of an embedded OSM page. The site's
 * content-security policy allows images from https but no frames, so the old
 * embed never drew on the tracking and trip-share pages; tiles are images.
 *
 * Privacy (W-47, M053): a tile request names only a ~1 km square at the zoom
 * used here, never a point, and never the page's address (where the trip and
 * parcel links carry their token). The marker is drawn by the page itself.
 * Callers pass a point already coarsened for display.
 *
 * Referer: the MapTiler key is restricted to the site's origins, which MapTiler
 * reads from the Referer, so each tile sends the site's ORIGIN only
 * (strict-origin-when-cross-origin — the same as the pin picker and the
 * site-wide policy). That overrides the token pages' own `no-referrer`, and
 * still never includes the path. Links stay no-referrer.
 *
 * A built site without the key has no tiles: the map says so and keeps the link.
 */
export const TILE_SIZE = 256;
export const TRACKING_ZOOM = 15;
/** Tiles cover ±512 px around the point, wide enough for any card it sits in. */
const REACH = 512;

export function tilesAround(point: Point, zoom: number, source: MapTileSource | null = mapTileSource()): Array<{ src: string; left: number; top: number }> {
  if (!source) return [];
  const pixel = mapPixel({ latitude: point.lat, longitude: point.lng }, zoom);
  const tiles: Array<{ src: string; left: number; top: number }> = [];
  for (let x = Math.floor((pixel.x - REACH) / TILE_SIZE); x <= Math.floor((pixel.x + REACH) / TILE_SIZE); x += 1) {
    for (let y = Math.floor((pixel.y - REACH / 2) / TILE_SIZE); y <= Math.floor((pixel.y + REACH / 2) / TILE_SIZE); y += 1) {
      if (y < 0 || y >= 2 ** zoom) continue;
      // Offsets from the point, which sits at the map's centre.
      tiles.push({ src: source.tileUrl(zoom, x, y), left: x * TILE_SIZE - pixel.x, top: y * TILE_SIZE - pixel.y });
    }
  }
  return tiles;
}

export function TileMap({ point, label, zoom = TRACKING_ZOOM, linkHref, linkLabel }: {
  point: Point;
  label: string;
  zoom?: number;
  linkHref: string;
  linkLabel: string;
}) {
  const [failed, setFailed] = useState(false);
  const source = mapTileSource();
  // [Row 108] One failed tile used to blank the whole map. Each tile is fetched
  // again once (a fresh element, so the browser asks again); only a tile that
  // fails twice makes the map say it could not load.
  const [retried, setRetried] = useState<ReadonlySet<string>>(() => new Set());
  const tileFailed = (src: string) => {
    if (retried.has(src)) setFailed(true);
    else setRetried((seen) => new Set(seen).add(src));
  };
  return (
    <div>
      <div role="img" aria-label={label} className="relative h-64 w-full overflow-hidden bg-[var(--swift-sunken)]">
        {!source ? (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[var(--swift-muted)]">{MAP_TILES_UNAVAILABLE} The link below opens it.</p>
        ) : failed ? (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-[var(--swift-muted)]">The map couldn’t load. The link below opens it.</p>
        ) : (
          tilesAround(point, zoom, source).map((tile) => (
            // Raster tiles keep their exact 256 px geometry and the browser's cache.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={retried.has(tile.src) ? `${tile.src}#retry` : tile.src}
              src={tile.src}
              alt=""
              width={TILE_SIZE}
              height={TILE_SIZE}
              draggable={false}
              referrerPolicy="strict-origin-when-cross-origin"
              onError={() => tileFailed(tile.src)}
              className="absolute max-w-none select-none"
              style={{ left: `calc(50% + ${tile.left}px)`, top: `calc(50% + ${tile.top}px)` }}
            />
          ))
        )}
        <span aria-hidden className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[var(--swift-white)] bg-[var(--swift-red)] shadow-[0_0_0_6px_var(--swift-red-50)]" />
        <MapAttribution source={source} className="absolute bottom-0 right-0 bg-[var(--swift-card)] px-1.5 py-0.5 text-[11px] text-[var(--swift-muted)]" />
      </div>
      <a className="block px-4 py-3 text-sm font-semibold text-[var(--swift-red)]" href={linkHref} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">
        {linkLabel}
      </a>
    </div>
  );
}
