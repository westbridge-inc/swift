import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY · ALG-34 parity] The store's MMG NUMBER replaces its pay link. The card
// shows the server's pending state verbatim, only the owner writes, the save goes through the step-up guard,
// and the "this wasn't me" cancel hits the number's own route. The old link card shows only while the server
// says the link is on.
// ---------------------------------------------------------------------------

const card = readFileSync(join(process.cwd(), 'src/components/MmgNumberCard.tsx'), 'utf8');
const api = readFileSync(join(process.cwd(), 'src/services/api.ts'), 'utf8');
const vendor = readFileSync(join(process.cwd(), 'src/modules/vendor/screens/VendorAccountScreen.tsx'), 'utf8');

describe('[PAYMENT-SIMPLIFY] the store MMG number card', () => {
  it('the pending number and its moment are the server\'s, verbatim', () => {
    expect(card).toContain('const when = fmtWhen(pending?.applyAt);');
    expect(card).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(card).toContain('New number takes effect ${when}');
    expect(card).toContain("'New number is waiting for its cool-off'");
    expect(card).toContain('Until then, customers keep paying your current number.');
  });

  it('says who sees it and when, and what "Paid by MMG" means', () => {
    expect(card).toContain('Customers who choose MMG see this number on their order after you accept it, and pay you directly.');
    expect(card).toContain('“Paid by MMG” on the order when the money is in your account.');
  });

  it('a manager reads, only the owner writes or cancels', () => {
    expect(card).toContain('Only the store owner can change where the money goes.');
    expect(vendor).toMatch(/<MmgNumberCard[\s\S]{0,600}readOnly=\{!isOwner\}/);
    expect(vendor).toContain('onCancelPending={isOwner ? () => cancelPendingMmgNumber.mutate() : undefined}');
    expect(vendor).toMatch(/\{isManager \? \(\s*<MmgNumberCard/);
  });

  it('the save is step-up guarded and the pending state comes from the profile read', () => {
    expect(vendor).toContain('stepUp.withStepUp((mmgNumber: string | null) => updateMmgNumber(mmgNumber))');
    expect(vendor).toContain('pending={store?.mmgNumberPending ? { number: store.mmgNumberPending, applyAt: store.mmgNumberApplyAt ?? null } : null}');
    expect(vendor).toContain("if (!isStepUpDismissed(e)) setMmgNumberError(serverMessage(e,");
  });

  it('the old link card renders only while the server says the link is on', () => {
    expect(vendor).toMatch(/\{isManager && store\?\.mmgPayLinkEnabled === true \? \(\s*<MmgPayLinkCard/);
  });

  it('the client hits the exact server routes', () => {
    expect(api).toContain("cancelPendingMmgNumber: () => api.delete('/vendor/profile/mmg-number/pending')");
    expect(api).toContain('mmgNumber?: string | null;');
  });
});
