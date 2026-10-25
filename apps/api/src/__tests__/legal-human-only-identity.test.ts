import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVACY, TERMS, CHILD_SAFETY } from '../modules/legal/legal.routes';
import { PROCESSOR_REGISTER } from '../modules/legal/processor-register';
import { productionKycReach } from './helpers/kyc-production-reach';

// ---------------------------------------------------------------------------
// [2026-10-17 · owner rulings: identity checks by a person only, face matching OFF (GUARDRAILS 8);
// customers take no photos (16 Oct)] THE POLICY SAYS WHAT PRODUCTION DOES.
//
// The policy used to name an outside identity-verification provider (Didit or ID Analyzer) running
// automated document-reading and face-matching on every verification document and selfie. Production
// refuses both adapters (getKycProvider + the boot guard accept only KYC_PROVIDER=manual) and refuses
// the face-match switch (boot-config.test.ts), so that sentence described processing that cannot happen. The reverse failure
// is as bad: the adapters still exist in source, so a later change could re-admit one while the policy
// says nobody receives the documents. So the words are graded against what the code admits.
// ---------------------------------------------------------------------------

afterEach(() => { vi.unstubAllEnvs(); });

const partyOf = (ref: string) => PROCESSOR_REGISTER.find((p) => p.ref === ref)!.party;
const aiParagraph = /<p><b>AI processing:<\/b>[\s\S]*?<\/p>/.exec(PRIVACY)?.[0] ?? '';

describe('[human-only identity] the Privacy Policy names only what production can reach', () => {
  it('production admits no external identity processor (guard: both adapters are seen and refused)', () => {
    const { admitted, refused } = productionKycReach();
    expect([...admitted]).toEqual([]);
    expect([...refused].sort()).toEqual(['DIDIT', 'ID_ANALYZER']);
  });

  it('a processor production refuses is not presented as a recipient', () => {
    const { refused } = productionKycReach();
    for (const ref of refused) {
      expect(PRIVACY, `${partyOf(ref)} cannot receive documents in production but the policy names it`).not.toContain(partyOf(ref));
    }
    expect(PRIVACY).not.toMatch(/processed by our identity-verification provider|identity-verification provider —/i);
  });

  it('while no external identity processor is admitted, the policy says people check, with no document-reading or face-matching', () => {
    const { admitted } = productionKycReach();
    if (admitted.size > 0) {
      for (const ref of admitted) expect(PRIVACY, `${partyOf(ref)} is admitted in production and must be disclosed`).toContain(partyOf(ref));
      return;
    }
    expect(aiParagraph).toContain('Identity verification is done by our verification team: Swift uses no automated document-reading or face-matching service, and no identity-verification provider receives your documents or selfie.');
    expect(PRIVACY).toContain('Identity verification is done by people: our verification team checks each partner document');
    expect(PRIVACY).toContain('No outside identity-verification provider receives them.');
  });

  it('a customer ID is described as it is handled: on file at once unless an automatic check holds it — never as checked by a person', () => {
    expect(aiParagraph).toContain("A customer's ID goes on file at once unless a simple automatic check holds it for a person");
    expect(aiParagraph).toContain('these checks never read the ID or compare faces');
    expect(aiParagraph).toContain('A person on our verification team then reviews each partner document and decides whether to accept it.');
  });
});

describe('[customers take no photos] the words say a customer never needs a photo, and no partner rule changed', () => {
  // [Owner ruling 24 Oct 2026 — NO CUSTOMER ID GATE] Since 2026-10-25 taxi rides and larger Orders need no ID either;
  // the Terms say when the app still asks for one.
  it('Terms: no profile photo for taxi, and no ID for taxi rides or larger Orders', () => {
    expect(TERMS).not.toMatch(/taxi rides also need a profile photo/);
    expect(TERMS).not.toMatch(/higher-value Orders and all taxi rides additionally require/);
    expect(TERMS).toContain('An account requires a phone number verified by SMS code. A customer needs no ID to place an Order or take a taxi ride; the app asks for a government-issued ID on file only after repeated failed deliveries or payments, or to use a high-value promotion. A customer never needs a photo.');
  });

  it('Privacy: the registration selfie is for partners and advertisers; a customer is never shown by photo', () => {
    expect(PRIVACY).toContain('<li><b>A registration selfie (partners and advertisers):</b>');
    expect(PRIVACY).toContain('A customer never needs a photo.');
    expect(PRIVACY).not.toMatch(/see each other's first names, photos and ratings/);
    expect(PRIVACY).toContain('A mover or business is never shown your last name or a photo of you.');
    // Only a taxi driver is served the passenger's rating (driver.routes ratingSurfaces CUSTOMER); a
    // delivery rider is not, so the words never say "a mover sees a customer's rating".
    expect(PRIVACY).toContain("a taxi driver also sees the passenger's rating.");
    expect(PRIVACY).not.toMatch(/a mover sees a customer's first name and rating/);
  });

  it('Child Safety: the photos that deter fake accounts are partners’', () => {
    expect(CHILD_SAFETY).toContain("partners' profile photos deter fake partner accounts.");
  });

  it('R28: confirmation records, never settlement records, in the Privacy Policy', () => {
    expect(PRIVACY).not.toMatch(/settlement records/);
    expect(PRIVACY).toContain('campaigns and confirmation records are handled correctly first');
  });
});

// [Owner ruling 17 Oct · COORD] A business that takes MMG gives Swift its MMG payment details, and its own
// customer is shown them on the order (customer.routes paymentAction: recipientName + the pay link today;
// an MMG number once stores give one). The words cover both, so they stay true across that change.
describe('[MMG direct pay] the Privacy Policy says the MMG details of a business are shown to its customer', () => {
  it('Sharing names the MMG payment details, the account name, and that the customer pays the business directly', () => {
    expect(PRIVACY).toContain('If a business takes MMG, the MMG payment details it gives Swift (its MMG number or pay link, and the name on that MMG account) are shown to you on your order, so you can pay the business directly.');
  });
});

// [COORD ruling 17 Oct] Who sees a customer's name and phone, as the code serves them: first name always,
// phone only to the business or mover handling the order, never the last name (customer-photo-egress census).
describe('[first name and phone] the Sharing words say what a business or mover handling the order sees', () => {
  it('a business and a mover see the first name and phone number, only to reach the customer about that order', () => {
    expect(PRIVACY).toContain('A business handling your order sees the items, your first name and delivery address, and your phone number, only so it can reach you about that order.');
    expect(PRIVACY).toContain("A mover handling your order sees the pickup and drop-off details, your first name and your phone number, only so they can reach you about that order; a taxi driver also sees the passenger's rating.");
    expect(PRIVACY).toContain('A mover or business is never shown your last name or a photo of you.');
  });

  // Customers are served a rider's first and last name, photo and phone (utils/counterparty) and a taxi
  // driver's first name, photo, phone and car (rides.routes): "name" is true of both.
  it('what a customer sees of the mover is complete: name, photo, rating and phone, and for a taxi the car', () => {
    expect(PRIVACY).toContain('Customers see the name, photo, rating and phone number of the mover handling their order, and for a taxi the car details.');
  });

  it('no first-name-only claim survives', () => {
    expect(PRIVACY).not.toMatch(/\(items, first name, delivery address\)|pickup\/drop-off details and your first name\./);
  });
});
