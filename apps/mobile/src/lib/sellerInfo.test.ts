import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASK_THE_STORE, sellerFacts, sellerPaymentLine, type StorefrontSeller } from './sellerInfo';

// ---------------------------------------------------------------------------
// [R3 · Consumer Affairs Act 2011 s.70 · legal research D10 + E5] Every store
// page says who sells, how payment works and the store's refund rule, then the
// statutory-rights sentence — the same words as the website's store page. A
// fact Swift does not hold reads "Ask the store", never a blank or a guess.
// Phone parts ship in build 12. Synthetic store facts only.
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

const src = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('[R3] the store page seller block', () => {
  it('lists the legal name, address, phone, payment and the refund rule, in that order', () => {
    expect(sellerFacts(full)).toEqual([
      { label: 'Legal name', value: 'Fixture Trader trading as Sample Kitchen' },
      { label: 'Business address', value: '1 Fixture Street, Georgetown' },
      { label: 'Phone', value: '+592 600 1300' },
      { label: 'How payment works', value: 'Cash at handover, or MMG straight to the store’s own MMG account' },
      { label: 'Refunds', value: 'Bring it back within 3 days with your receipt.' },
    ]);
  });

  it('says "Ask the store" for every fact not on file, and names cash only without the store’s own MMG', () => {
    const bare = sellerFacts({ ...full, legalName: null, address: null, phone: null, refundRule: null, payment: { cash: true, storeMmg: false } });
    expect(bare.filter((f) => f.value === ASK_THE_STORE).map((f) => f.label)).toEqual(['Legal name', 'Business address', 'Phone', 'Refunds']);
    expect(sellerPaymentLine({ cash: true, storeMmg: false })).toBe('Cash at handover');
  });

  // [FOOD-PERMIT · owner 24 Oct 2026] A restaurant's food handler's certificate is optional; one on file is a trust badge.
  it('names a food handler’s certificate on file, after payment; nothing when the server says none (or an older server)', () => {
    const facts = sellerFacts({ ...full, foodHandlerCertificate: true });
    expect(facts.map((f) => f.label)).toEqual(['Legal name', 'Business address', 'Phone', 'How payment works', 'Food handler’s certificate', 'Refunds']);
    expect(facts.find((f) => f.label === 'Food handler’s certificate')?.value).toBe('On file with Swift');
    expect(sellerFacts({ ...full, foodHandlerCertificate: false }).some((f) => f.label === 'Food handler’s certificate')).toBe(false);
    expect(sellerFacts(full).some((f) => f.label === 'Food handler’s certificate')).toBe(false);
  });

  it('the store screen renders the server’s block (none from an older API), with the statutory sentence the server sent', () => {
    expect(src('src/modules/shop/screens/RestaurantScreen.tsx')).toContain('{v.seller ? <SellerInfo seller={v.seller} gutter={GUTTER} /> : null}');
    const card = src('src/components/SellerInfo.tsx');
    expect(card).toContain('sellerFacts(seller).map(');
    expect(card).toContain('{seller.statutoryRights}');
    expect(card).toContain('accessibilityLabel="Seller information"');
  });

  it('only the owner gets the refund-rule card, and it saves exactly the field the API reads', () => {
    const account = src('src/modules/vendor/screens/VendorAccountScreen.tsx');
    expect(account).toMatch(/\{isOwner \? \(\s*<RefundRuleCard/);
    expect(account).toContain('vendorApi.updateProfile({ refundRule })');
    expect(account).toContain('value={store?.refundRule}');
    const card = src('src/components/RefundRuleCard.tsx');
    expect(card).toContain('onPress={() => onSave(trimmed || null)}');
    expect(card).toContain('maxLength={REFUND_RULE_MAX}');
  });
});
