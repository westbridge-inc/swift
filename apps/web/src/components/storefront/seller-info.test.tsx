import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StorefrontSeller } from '@/lib/api';
import { axeViolations } from '@/test/axe';
import { SellerInfo } from './seller-info';

// ---------------------------------------------------------------------------
// [R3 · Consumer Affairs Act 2011 s.70 · legal research D10 + E5] Every store
// page says who sells, how payment works and the store's refund rule, followed
// by the statutory-rights sentence. A fact Swift does not hold reads "Ask the
// store" — never a blank row and never a guess. Synthetic store facts only.
// ---------------------------------------------------------------------------

const STATUTORY = "This does not affect your rights under Guyana's Consumer Affairs Act 2011 to return goods or get a refund from the business.";
const full: StorefrontSeller = {
  legalName: 'Fixture Trader trading as Sample Kitchen',
  address: '1 Fixture Street, Georgetown',
  phone: '+5926001300',
  payment: { cash: true, storeMmg: true },
  refundRule: 'Bring it back within 3 days with your receipt.',
  statutoryRights: STATUTORY,
};

const fact = (label: string) => {
  const term = screen.getByText(label, { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
};

describe('[R3] the storefront seller block', () => {
  it('shows the legal name, address, phone, payment, the refund rule and the statutory sentence', async () => {
    const { container } = render(<SellerInfo seller={full} />);
    const block = screen.getByRole('region', { name: 'Seller information' });
    expect(fact('Legal name').textContent).toBe('Fixture Trader trading as Sample Kitchen');
    expect(fact('Business address').textContent).toBe('1 Fixture Street, Georgetown');
    expect(within(fact('Phone')).getByRole('link', { name: '+5926001300' }).getAttribute('href')).toBe('tel:+5926001300');
    expect(fact('How payment works').textContent).toBe('Cash at handover, or MMG straight to the store’s own MMG account');
    expect(fact('Refunds').textContent).toBe(`Bring it back within 3 days with your receipt.${STATUTORY}`);
    expect(within(block).getByText(STATUTORY)).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('says "Ask the store" for every fact not on file, names cash only without the store’s own MMG, and still prints the statutory sentence', () => {
    render(<SellerInfo seller={{ ...full, legalName: null, address: null, phone: null, refundRule: null, payment: { cash: true, storeMmg: false } }} />);
    for (const label of ['Legal name', 'Business address', 'Phone']) expect(fact(label).textContent).toBe('Ask the store');
    expect(fact('How payment works').textContent).toBe('Cash at handover');
    expect(fact('Refunds').textContent).toBe(`Ask the store${STATUTORY}`);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
