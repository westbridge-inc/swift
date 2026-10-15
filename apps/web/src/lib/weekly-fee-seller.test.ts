import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutSeller, type CheckoutStatus } from './weekly-fee';

// [Owner 15 Oct 2026 · ruling #63 · legal research R2] Every weekly-fee receipt on the website names the seller —
// Swift's operator — in the words the API sends (one source: apps/api/src/modules/legal/operator.ts). An older
// API sends none, and the card then says nothing rather than something invented.
const SELLER = { name: 'Westbridge Inc.', tradingAs: 'Swift', registrationNo: '17703', registeredAddress: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana', phone: '+592 716 3534', email: 'support@swiftgy.com' };
const { phone: _p, email: _e, ...OLDER_SELLER } = SELLER; // an API before R2 sent no phone or e-mail
const base: CheckoutStatus = { ref: 'r1', status: 'CONFIRMED', amountGyd: 8000, currencyCode: 'GYD', createdAt: '2026-10-15T00:00:00Z', expiresAt: '2026-10-15T00:10:00Z', confirmedAt: '2026-10-15T00:01:00Z', subscriptionStatus: 'ACTIVE' };

describe('the weekly-fee receipt names its seller', () => {
  it('as the API states it', () => {
    expect(checkoutSeller({ ...base, seller: SELLER })).toBe('Sold by Westbridge Inc. (registration no. 17703), Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana. Phone +592 716 3534, email support@swiftgy.com');
    expect(checkoutSeller({ ...base, seller: OLDER_SELLER })).toBe('Sold by Westbridge Inc. (registration no. 17703), Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana');
    expect(checkoutSeller(base)).toBeNull();
  });

  it('each recent checkout card shows it, and the site writes neither the name nor the address itself', () => {
    const card = readFileSync(join(process.cwd(), 'src', 'components', 'weekly-fee.tsx'), 'utf8');
    expect(card).toMatch(/checkoutSeller\(shown\) \? <p[^>]*data-testid="fee-seller">\{checkoutSeller\(shown\)\}<\/p> : null/);
    expect(card + readFileSync(join(process.cwd(), 'src', 'lib', 'weekly-fee.ts'), 'utf8')).not.toMatch(/Westbridge|Lot 165/);
  });
});
