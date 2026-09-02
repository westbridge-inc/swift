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

/** [M-34] The outer ring of a GeoJSON Polygon as [lng, lat] pairs, or null. */
export function outerRing(polygon: unknown): number[][] | null {
  const geo = polygon as GeoJsonPolygon | null;
  if (!geo || geo.type !== 'Polygon' || !Array.isArray(geo.coordinates) || geo.coordinates.length === 0) return null;
  const ring = geo.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  return ring.filter((pt) => Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number');
}

/** [M-34] Shoelace area of the outer ring in square degrees — only ever
 *  compared with another zone's, so the unit does not matter. */
export function polygonArea(polygon: unknown): number {
  const ring = outerRing(polygon);
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    sum += xj! * yi! - xi! * yj!;
  }
  return Math.abs(sum) / 2;
}

function segmentsCross(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  const orient = (p: number[], q: number[], r: number[]) => {
    const v = (q[1]! - p[1]!) * (r[0]! - q[0]!) - (q[0]! - p[0]!) * (r[1]! - q[1]!);
    return v === 0 ? 0 : v > 0 ? 1 : 2;
  };
  const onSegment = (p: number[], q: number[], r: number[]) =>
    q[0]! <= Math.max(p[0]!, r[0]!) && q[0]! >= Math.min(p[0]!, r[0]!) && q[1]! <= Math.max(p[1]!, r[1]!) && q[1]! >= Math.min(p[1]!, r[1]!);
  const o1 = orient(a1, a2, b1); const o2 = orient(a1, a2, b2); const o3 = orient(b1, b2, a1); const o4 = orient(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

/** [M-34] Do two polygons share any area? A vertex of one inside the other,
 *  or any two edges crossing — after a bounding-box reject. Touching along an
 *  edge counts as overlap (two zones must not both claim a kerb). */
export function polygonsOverlap(a: unknown, b: unknown): boolean {
  const ra = outerRing(a); const rb = outerRing(b);
  if (!ra || !rb) return false;
  const box = (r: number[][]) => ({
    minX: Math.min(...r.map((p) => p[0]!)), maxX: Math.max(...r.map((p) => p[0]!)),
    minY: Math.min(...r.map((p) => p[1]!)), maxY: Math.max(...r.map((p) => p[1]!)),
  });
  const ba = box(ra); const bb = box(rb);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxY < bb.minY || bb.maxY < ba.minY) return false;
  if (ra.some((p) => pointInPolygon({ lng: p[0]!, lat: p[1]! }, b))) return true;
  if (rb.some((p) => pointInPolygon({ lng: p[0]!, lat: p[1]! }, a))) return true;
  for (let i = 0, j = ra.length - 1; i < ra.length; j = i++) {
    for (let k = 0, l = rb.length - 1; k < rb.length; l = k++) {
      if (segmentsCross(ra[j]!, ra[i]!, rb[l]!, rb[k]!)) return true;
    }
  }
  return false;
}
