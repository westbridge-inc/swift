/**
 * Ray-casting point-in-polygon over a GeoJSON Polygon. Zones store
 * { type: 'Polygon', coordinates: [[[lng, lat], ...]] } — only the outer
 * ring matters for fare zones. Pure and boundary-deterministic enough for
 * pricing (a point exactly on an edge resolves consistently per ring
 * orientation; fare zones overlap-pad in practice).
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

interface GeoJsonPolygon {
  type: string;
  coordinates: number[][][];
}

export function pointInPolygon(point: GeoPoint, polygon: unknown): boolean {
  const geo = polygon as GeoJsonPolygon | null;
  if (!geo || geo.type !== 'Polygon' || !Array.isArray(geo.coordinates) || geo.coordinates.length === 0) {
    return false;
  }
  const ring = geo.coordinates[0]!;
  if (!Array.isArray(ring) || ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;

    const intersects =
      (yi > point.lat) !== (yj > point.lat) &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
