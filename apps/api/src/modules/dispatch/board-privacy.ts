/** The same coarse grid on every unassigned private-point surface. */
export const PRIVATE_POINT_SNAP_DEG = 0.003;

export function coarsePoint(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat: Math.round(lat / PRIVATE_POINT_SNAP_DEG) * PRIVATE_POINT_SNAP_DEG,
    lng: Math.round(lng / PRIVATE_POINT_SNAP_DEG) * PRIVATE_POINT_SNAP_DEG,
  };
}
