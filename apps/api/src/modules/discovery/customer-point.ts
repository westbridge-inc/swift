import { launchMarketAt } from '../auth/launch-market';

/**
 * [REVIEW-READY] The ONE door a customer's coordinates pass through on every
 * discovery surface (Home, browse, a store page, favourites, the cart preview,
 * the category rail, search).
 *
 * A point inside a launch market is used as sent. A point in NO launch market
 * — an App Store reviewer in California, a relative browsing from New York, a
 * 0,0 fix — reads exactly as "no location": no distance, no ETA, no delivery
 * fee priced across an ocean, no radius filter that empties every rail. From
 * Apple Park, the store cards used to say 9,422 km, 22,650 minutes and a
 * GY$1,884,603 delivery fee; the location-off path is the one every app build
 * already renders.
 *
 * Inside a market nothing changes, including a store beyond its own delivery
 * radius: checkout refuses that delivery (OUT_OF_SERVICE_AREA) and the card is
 * a separate display question.
 */
export function customerPoint<T extends { lat?: number | null; lng?: number | null }>(
  query: T,
): Omit<T, 'lat' | 'lng'> & { lat: number | undefined; lng: number | undefined } {
  const { lat, lng, ...rest } = query;
  if (lat == null || lng == null || launchMarketAt(lat, lng) === null) {
    return { ...rest, lat: undefined, lng: undefined };
  }
  return { ...rest, lat, lng };
}
