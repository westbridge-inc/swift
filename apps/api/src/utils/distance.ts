const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Haversine distance between two lat/lng points in kilometers.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate driving distance (haversine * 1.3 detour factor).
 */
export function estimateDrivingDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return haversineDistance(lat1, lng1, lat2, lng2) * 1.3;
}

/**
 * Estimate delivery time in minutes based on distance.
 * Assumes 25 km/h average speed in Georgetown + 5 min overhead.
 */
export function estimateDeliveryMinutes(distanceKm: number): number {
  return Math.ceil((distanceKm / 25) * 60) + 5;
}

/**
 * Check if a point is within a radius of another point.
 */
export function isWithinRadius(
  centerLat: number,
  centerLng: number,
  pointLat: number,
  pointLng: number,
  radiusKm: number,
): boolean {
  return haversineDistance(centerLat, centerLng, pointLat, pointLng) <= radiusKm;
}

/**
 * Sort an array of items by distance from a reference point.
 */
export function sortByDistance<T extends { latitude: number; longitude: number }>(
  items: T[],
  fromLat: number,
  fromLng: number,
): (T & { distance: number })[] {
  return items
    .map((item) => ({
      ...item,
      distance: haversineDistance(fromLat, fromLng, item.latitude, item.longitude),
    }))
    .sort((a, b) => a.distance - b.distance);
}
