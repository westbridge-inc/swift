// [TAXI route line · MAPS-CHECK G1] What the driver's map draws between a
// ride's points. The server answers GET /driver/rides/:id/route with the road
// from its routing engine ('road') or, when it has none, the points themselves
// ('straight'). The map draws the road when there is one; otherwise the
// straight heading through the pickup, the stops and the drop-off, exactly as
// before (and always on a server from before the route read).

export interface MapPoint {
  latitude: number;
  longitude: number;
}

/** The road's points from the route answer, or null when the answer is not a
 *  usable road: missing, 'straight', or anything malformed (a point that is
 *  not a real coordinate, or fewer than two points). */
export function roadPointsFrom(answer: unknown): MapPoint[] | null {
  const a = answer as { source?: unknown; points?: unknown } | null | undefined;
  if (!a || a.source !== 'road' || !Array.isArray(a.points) || a.points.length < 2) return null;
  const out: MapPoint[] = [];
  for (const p of a.points as unknown[]) {
    const q = p as { lat?: unknown; lng?: unknown } | null;
    if (!q || typeof q.lat !== 'number' || typeof q.lng !== 'number') return null;
    if (!Number.isFinite(q.lat) || !Number.isFinite(q.lng) || Math.abs(q.lat) > 90 || Math.abs(q.lng) > 180) return null;
    out.push({ latitude: q.lat, longitude: q.lng });
  }
  return out;
}

/** The line the driver's map draws: the road when the server sent one, else
 *  the straight heading through `straight` (pickup, stops, drop-off). `road`
 *  says which, so only the straight line is drawn geodesic. With no straight
 *  line to stand in for (no pickup or drop-off), nothing is drawn. */
export function driverMapLine(answer: unknown, straight: MapPoint[]): { coordinates: MapPoint[]; road: boolean } {
  const road = straight.length >= 2 ? roadPointsFrom(answer) : null;
  return road ? { coordinates: road, road: true } : { coordinates: straight, road: false };
}

/** Which stops are skipped, as part of the read's key: a skip takes the stop
 *  out of the road, so the line is asked for again — and only then. */
export function skippedStopsKey(stops: readonly { sequence: number; status?: string }[]): string {
  return stops.filter((s) => s.status === 'SKIPPED').map((s) => s.sequence).sort((x, y) => x - y).join(',');
}
