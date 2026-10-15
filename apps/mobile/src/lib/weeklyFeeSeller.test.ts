import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutSeller, type CheckoutStatus } from './weeklyFee';

// [Owner 15 Oct 2026 · ruling #63] Every weekly-fee receipt in the app names the seller — Swift's operator —
// in the words the API sends (one source: apps/api/src/modules/legal/operator.ts). An older API sends none.
const SELLER = { name: 'Westbridge Inc.', tradingAs: 'Swift', registrationNo: '17703', registeredAddress: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana', phone: '+592 716 3534', email: 'support@swiftgy.com' };
const OLDER_SELLER = { name: SELLER.name, tradingAs: SELLER.tradingAs, registrationNo: SELLER.registrationNo, registeredAddress: SELLER.registeredAddress }; // an API before R2 sent no phone or e-mail
const SCREEN = readFileSync(join(process.cwd(), 'src', 'modules', 'billing', 'screens', 'WeeklyFeeScreen.tsx'), 'utf8');

describe('the weekly-fee receipt names its seller', () => {
  const base: CheckoutStatus = { ref: 'r1', status: 'CONFIRMED', amountGyd: 8000, currencyCode: 'GYD', createdAt: '2026-10-15T00:00:00Z', expiresAt: '2026-10-15T00:10:00Z', confirmedAt: '2026-10-15T00:01:00Z', subscriptionStatus: 'ACTIVE' };

  it('says who sold the fee, as the API states it', () => {
    expect(checkoutSeller({ ...base, seller: SELLER })).toBe('Sold by Westbridge Inc. (registration no. 17703), Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana. Phone +592 716 3534, email support@swiftgy.com');
    expect(checkoutSeller({ ...base, seller: OLDER_SELLER })).toBe('Sold by Westbridge Inc. (registration no. 17703), Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana');
    expect(checkoutSeller(base)).toBeNull();
  });

  it('the screen shows it on each recent checkout', () => {
    expect(SCREEN).toMatch(/checkoutSeller\(shown\) \? <T [^>]*testID="fee-seller">\{checkoutSeller\(shown\)\}<\/T> : null/);
  });

  it('the app writes neither the name nor the address itself', () => {
    expect(SCREEN).not.toMatch(/Westbridge|Lot 165/);
    expect(readFileSync(join(process.cwd(), 'src', 'lib', 'weeklyFee.ts'), 'utf8')).not.toMatch(/Westbridge|Lot 165/);
  });
});
