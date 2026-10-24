import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF] Every shopping page loads lib/customer (the frame reads the market
// depth from it), and it used to carry every customer call: sign-up, orders and
// the swap answer, search, courier, place search, rides, the Market tab's
// goods. /order/browse, /cart and
// /checkout sat at their first-load ceilings, so the swap calls (#1831) pushed
// all three over. The calls only some pages use now live in small modules that
// only those pages (or on-demand pickers) import, moved verbatim. Behaviour is
// unchanged: auth.test.ts pins the sign-up requests, the orders page tests pin
// the swap view and answer, the place box tests pin place search.
// ---------------------------------------------------------------------------

const src = join(__dirname, '../..');
const read = (path: string) => (existsSync(join(src, path)) ? readFileSync(join(src, path), 'utf8') : '');
const imports = (source: string) => source.split('\n').filter((line) => /^import\s/.test(line));

const MOVED: Record<string, { calls: string[]; imports: string[]; users: Record<string, string> }> = {
  'lib/customer-account.ts': {
    calls: ['verifyOtp', 'registerAccount', 'uploadSelfie', 'becomePartner'],
    imports: [
      "import { BROWSER_CLIENT, adoptSession, apiFetch } from './auth';",
      "import { BROWSER_API_ORIGIN as API_BASE } from '@/lib/browser-api-origin';",
    ],
    users: {
      'app/signup/page.tsx': "import { verifyOtp, registerAccount, becomePartner } from '@/lib/customer-account';",
      'app/selfie/page.tsx': "import { uploadSelfie } from '@/lib/customer-account';",
    },
  },
  'lib/customer-orders.ts': {
    // [UI-SWEEP U13 / U17] The list reads live orders and paged history apart, and reorders.
    calls: ['getLiveOrders', 'getOrderHistoryPage', 'reorder', 'getOrder', 'decideSubstitution', 'cancelOrder'],
    imports: ["import { apiFetch } from './auth';"],
    users: {
      'app/(app)/orders/page.tsx': "import { getLiveOrders, getOrderHistoryPage, reorder } from '@/lib/customer-orders';",
      'app/(app)/orders/[id]/page.tsx': "import { cancelOrder, decideSubstitution, getOrder } from '@/lib/customer-orders';",
    },
  },
  'lib/customer-search.ts': {
    calls: ['searchCatalogue', 'searchSuggestions', 'searchTrending'],
    imports: ["import { apiFetch } from './auth';", "import type { MarketItem } from './customer';"],
    users: { 'app/(app)/order/search/page.tsx': "import { searchCatalogue, searchSuggestions, searchTrending, TRENDING_SHOWN, type CatalogueResults, type SearchSuggestion } from '@/lib/customer-search';" },
  },
  'lib/customer-courier.ts': {
    calls: ['courierEstimate', 'requestCourier'],
    imports: ["import { apiFetch } from './auth';"],
    users: { 'app/(app)/courier/page.tsx': "import { courierEstimate, requestCourier, type CourierRequest } from '@/lib/customer-courier';" },
  },
  'lib/customer-rides.ts': {
    calls: ['rideAvailability', 'rideEstimate', 'activeRide', 'getRide', 'watchRide', 'rideCapabilities', 'requestRide', 'rideSos'],
    imports: ["import { apiFetch } from './auth';"],
    users: {
      'app/(app)/orders/[id]/page.tsx': "import { activeRide, getRide, rideCapabilities } from '@/lib/customer-rides';",
      'app/(app)/taxi/taxi-fare-estimate.tsx': "import { activeRide, rideCapabilities, rideEstimate } from '@/lib/customer-rides';",
      'app/(app)/taxi/taxi-booking.tsx': "import { requestRide, type WebRideRequest } from '@/lib/customer-rides';",
      'components/taxi-trip-safety.tsx': "import { rideSos } from '@/lib/customer-rides';",
    },
  },
  'lib/customer-market.ts': {
    calls: ['getMarketItems', 'getMarketCategories'],
    imports: ["import { publicGet, type MarketCategory, type MarketItem } from './customer';", "import { retailCategories } from './browse-keys';"],
    users: { 'app/(app)/market/market-screen.tsx': "import { getMarketCategories, getMarketItems } from '@/lib/customer-market';" },
  },
  'lib/customer-places.ts': {
    calls: ['placesAutocomplete', 'placeDetails'],
    imports: ["import { apiFetch } from './auth';"],
    users: {
      'components/location-field.tsx': "import { placesAutocomplete, placeDetails, type Place } from '@/lib/customer-places';",
      'components/store-location-picker.tsx': "import { placesAutocomplete, placeDetails, type Place } from '@/lib/customer-places';",
      'components/pin-picker/pin-picker.tsx': "import { placeDetails, placesAutocomplete, type Place } from '@/lib/customer-places';",
    },
  },
};

describe('[PERF] the shared customer client carries only what the shopping pages share', () => {
  it('lib/customer no longer defines the calls that moved (one home each, so a stub cannot miss a copy)', () => {
    const customer = read('lib/customer.ts');
    const left = Object.values(MOVED).flatMap((m) => m.calls).filter((call) => new RegExp(`export (async )?function ${call}\\(`).test(customer));
    expect(left).toEqual([]);
  });

  it.each(Object.entries(MOVED))('%s defines its calls and imports only the shared request code', (file, moved) => {
    const source = read(file);
    for (const call of moved.calls) expect(source, `${file} defines ${call}`).toMatch(new RegExp(`export (async )?function ${call}\\(`));
    expect(imports(source)).toEqual(moved.imports);
  });

  it.each(Object.entries(MOVED))('the pages that use %s import it from there', (_file, moved) => {
    for (const [page, line] of Object.entries(moved.users)) expect(imports(read(page)), page).toContain(line);
  });
});
