import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] When the customer pays the store by
// MMG, the store taps ONE plainly worded button when it sees the money in its
// own MMG account: "Paid by MMG". Swift never checks the money itself.
describe('[PAYMENT-SIMPLIFY] the store confirm button says "Paid by MMG"', () => {
  it('VendorOps labels the confirm button exactly "Paid by MMG"', () => {
    const src = readFileSync(join(__dirname, 'screens/VendorOps.tsx'), 'utf8');
    expect(src).toMatch(/label="Paid by MMG"[\s\S]{0,400}onAction\('confirm-payment'/);
    expect(src).not.toMatch(/received in my MMG/);
  });
});
