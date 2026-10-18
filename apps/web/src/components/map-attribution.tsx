import type { MapTileSource } from '@/lib/map-tiles';

/**
 * [WEB-TILES] The credit line under every map that draws tiles, from the one
 * tile source (lib/map-tiles.ts): "© MapTiler © OpenStreetMap contributors"
 * for MapTiler's tiles; OpenStreetMap's contributors alone for development's
 * OpenStreetMap tiles. A map with no tiles draws no map data and no credit.
 * The links tell the credited sites nothing about the page (no referrer).
 */
export function MapAttribution({ source, className }: { source: MapTileSource | null; className?: string }) {
  if (!source) return null;
  return (
    <p className={className}>
      {source.provider === 'maptiler' ? (
        <>© <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="underline">MapTiler</a> </>
      ) : null}
      © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" referrerPolicy="no-referrer" className="underline">OpenStreetMap contributors</a>
    </p>
  );
}
