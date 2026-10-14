/** The same coarse grid on every unassigned private-point surface. */
export const PRIVATE_POINT_SNAP_DEG = 0.003;

export function coarsePoint(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat: Math.round(lat / PRIVATE_POINT_SNAP_DEG) * PRIVATE_POINT_SNAP_DEG,
    lng: Math.round(lng / PRIVATE_POINT_SNAP_DEG) * PRIVATE_POINT_SNAP_DEG,
  };
}

/** A ride's intermediate stop as someone who has not accepted the ride sees it
 *  (board row, live offer card, recovered offer card): its place in the order
 *  and a coarse point, never the typed address or the exact position. */
export interface CoarseStop { sequence: number; lat: number | null; lng: number | null }

export function coarseStops(stops: readonly { sequence: number; lat: number | null; lng: number | null }[]): CoarseStop[] {
  return stops.map((stop) => {
    const point = coarsePoint(stop.lat, stop.lng);
    return { sequence: stop.sequence, lat: point?.lat ?? null, lng: point?.lng ?? null };
  });
}

/** The addresses a pre-accept offer card may name. A store's own pickup
 *  address is public (it is on the storefront); a courier sender's pickup, a
 *  taxi pickup and every drop-off are someone's private place, so the card
 *  names none of them until the job is accepted. Keys stay (null) so an
 *  installed app's fallbacks ("store name", "Pickup nearby") keep working. */
export function offerCardAddresses(order: { orderType: string; pickupAddress: string | null; deliveryAddress: string | null }): {
  pickupAddress: string | null; deliveryAddress: null;
} {
  const privatePickup = order.orderType === 'COURIER' || order.orderType === 'TAXI';
  return { pickupAddress: privatePickup ? null : order.pickupAddress ?? null, deliveryAddress: null };
}
