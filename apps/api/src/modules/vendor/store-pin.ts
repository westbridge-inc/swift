import { AppError } from '../../utils/errors';
import { launchMarketAt } from '../auth/launch-market';

// ---------------------------------------------------------------------------
// [Q8] The store pin. Owner report: a store must never simply take the spot its
// owner happened to sign up from. The pin is where riders and customers are
// sent and what decides which shoppers see the store as nearby, so every writer
// of store coordinates (POST /partner/become for a new store, PUT
// /vendor/profile for a moved one) refuses a pin that lies in no launch market.
// A refusal is a named 400, so the app can say what to do: move the pin.
// ---------------------------------------------------------------------------

export const STORE_PIN_OUT_OF_MARKET = 'STORE_PIN_OUT_OF_MARKET';

export function assertStorePinInMarket(latitude: number, longitude: number): void {
  if (launchMarketAt(latitude, longitude) !== null) return;
  throw new AppError(
    400,
    STORE_PIN_OUT_OF_MARKET,
    'That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.',
  );
}
