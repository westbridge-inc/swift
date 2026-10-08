import { launchMarketAt } from '../auth/launch-market';
import { AppError } from '../../utils/errors';

/** Quote and creation entrances share the existing launch-market predicate.
 * Do not let a routing engine snap an unsupported point back onto its map. */
export function assertRoadTripInMarket(trip: {
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
}): void {
  for (const end of ['pickup', 'dropoff'] as const) {
    const point = trip[end];
    if (launchMarketAt(point.lat, point.lng) !== null) continue;
    throw new AppError(400, 'ROUTE_OUT_OF_MARKET',
      `Your ${end === 'pickup' ? 'pickup' : 'destination'} is outside Guyana, where Swift works today. Choose a place in Guyana.`,
      { place: end === 'pickup' ? 'PICKUP' : 'DESTINATION' });
  }
}
