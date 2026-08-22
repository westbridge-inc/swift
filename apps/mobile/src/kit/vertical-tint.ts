import type { PictogramName } from './pictograms';

/**
 * VERTICAL IDENTITY — the super-app launcher's per-service colour.
 *
 * This ramp existed before, as a local `VERTICAL_TINT` map inside HomeScreen,
 * and the app's no-literal-hex-in-screens lint rule is what eventually cleaned
 * it away. The grid collapsed back to eight identical brand-tinted squares, and
 * the founder's verdict on that screen was that it did not feel like a super
 * app at all — correctly, because Food, a whole business vertical, then carried
 * exactly the visual weight of Favourites, a bookmark [F-263]. Living in the
 * kit is what stops a tidiness pass from deleting it a second time.
 *
 * These are NOT the functional tokens. `success`, `warning`, `info` and `error`
 * carry RESERVED meanings — delivered/paid, caution, notice, failure — and the
 * palette law says they are never decoration. Spending viridian on Groceries
 * would make green mean two different things on the same screen. So verticals
 * get their own muted, maroon-harmonised ramp whose only job is telling one
 * service apart from another: identity colour, never status colour.
 *
 * The standing lever on this product, from the founder's own on-device QA:
 * GO RICHER, NOT CLEANER. Clean-minimal is what made it read as basic.
 */
export const VERTICAL_TINT: Partial<Record<PictogramName, { bg: string; ink: string }>> = {
  food: { bg: '#F7E7E8', ink: '#8C2F39' }, // the flagship keeps the house red
  groceries: { bg: '#E7F0EA', ink: '#2E6B4F' }, // market green, off the viridian
  shops: { bg: '#F0E9F2', ink: '#6B3F6E' }, // plum
  taxi: { bg: '#F9EFE3', ink: '#A65D1E' }, // amber — the road
  send: { bg: '#E9EFF4', ink: '#3B5B7A' }, // slate blue — parcels
  services: { bg: '#E5F0F1', ink: '#2A6A70' }, // teal — trades
  orders: { bg: '#F2EDE7', ink: '#6B5344' }, // paper brown — the receipt
  favourites: { bg: '#F8E8EC', ink: '#A33F5B' }, // rose
};
