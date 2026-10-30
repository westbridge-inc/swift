/**
 * [FOOD-PERMIT · owner ruling 24 Oct 2026] The restaurant food handler's certificate.
 *
 *  - A REGISTERED restaurant no longer has to upload a food handler's certificate: it may (RESTAURANT_OPTIONAL — still
 *    uploadable, still reviewed by a person, still shown on the storefront while it is current). Its owner instead
 *    TICKS "Everyone who handles food here holds a current food handler's certificate." (vendor/food-handlers.ts).
 *  - A self-declared (UNREGISTERED) food seller — a home cook — keeps the certificate REQUIRED. Chefs and caterers keep theirs.
 *  - [REVIEW-G #2053 S4-4] The electrician gets the GEI licence floor the solar installer has.
 *
 * These are the list/verdict pins; food-handlers.test.ts proves the gate end to end on a database.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCUMENT_CHECKLISTS, PLATFORM_CONFIG_VERSION, SERVICE_TRADE_LAUNCH_FLOOR } from '../modules/ops/platform-config';
import { vendorActivationNext, vendorActivationRefusal } from '../modules/admin/vendor-activation';
import { feePausePredicate } from '../modules/billing/mmg-pause';
import { FOOD_HANDLERS_TICK_V1, FOOD_HANDLERS_VERSION, attestedStoreIds, foodHandlerTickApplies } from '../modules/vendor/food-handlers';
import { FOOD_HANDLER_ATTESTATION_TYPE } from '../modules/verification/doc-registry';
import { storefrontSeller } from '../modules/verification/storefront-seller';
import type { DisclosureBlock } from '../modules/verification/storefront-disclosure';

const CERT = 'food_handler_cert';

describe('[FOOD-PERMIT] the restaurant lists', () => {
  it('a registered restaurant (business name or own name) no longer must upload the certificate, and may', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT']).toEqual(['owner_national_id', 'business_registration', 'gra_restaurant_licence', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_OWN_NAME']).toEqual(['owner_national_id', 'own_name_declaration', 'gra_restaurant_licence', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_OPTIONAL']).toEqual([CERT]);
  });

  it('a home cook (self-declared tier) keeps it required; chef and caterer keep theirs', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_UNREGISTERED']).toContain(CERT);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER_TRADE_CHEF']).toEqual([CERT]);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER_TRADE_CATERER']).toEqual([CERT, 'eating_house_registration']);
    expect(SERVICE_TRADE_LAUNCH_FLOOR['chef']).toContain(CERT);
    expect(SERVICE_TRADE_LAUNCH_FLOOR['caterer']).toContain(CERT);
  });

  it('the tick is never a document on any list: it is asked of the store by code, whatever a stored list says', () => {
    for (const [key, list] of Object.entries(DEFAULT_DOCUMENT_CHECKLISTS)) expect(list, key).not.toContain(FOOD_HANDLER_ATTESTATION_TYPE);
  });

  it('[REVIEW-G #2053 S4-4] the electrician has the GEI licence floor, like the solar installer', () => {
    expect(SERVICE_TRADE_LAUNCH_FLOOR['electrician']).toEqual(['national_id', 'police_clearance', 'gei_electrical_licence']);
  });

  it('the config version moves above 2026-10-22.1 (an owner-signed seed carries the new lists)', () => {
    // [DEPT-PRICE] 2026-10-29.1 carries these lists on, with the department-store fee at 45,000 (dept-price.unit.test.ts)
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-10-29.1');
  });
});

describe('[FOOD-PERMIT] who ticks', () => {
  it('a registered restaurant only: never a home cook, never another store type', () => {
    expect(foodHandlerTickApplies({ vendorType: 'RESTAURANT', tier: 'REGISTERED' })).toBe(true);
    expect(foodHandlerTickApplies({ vendorType: 'RESTAURANT', tier: 'UNREGISTERED' })).toBe(false);
    for (const vendorType of ['SUPERMARKET', 'STORE', 'SERVICE']) expect(foodHandlerTickApplies({ vendorType, tier: 'REGISTERED' }), vendorType).toBe(false);
  });

  it('the words are the owner’s, at a pinned version', () => {
    expect(FOOD_HANDLERS_TICK_V1).toBe('Everyone who handles food here holds a current food handler’s certificate.');
    expect(FOOD_HANDLERS_VERSION).toBe('v1');
  });
});

// [REVIEW-G #2062 S4-2] Which tick stands: only a grant of the CURRENT words. A grant of other (older) words counts for
// nothing, so when new words ship every restaurant is asked to tick again.
describe('[FOOD-PERMIT] which tick counts: the current words only', () => {
  type Row = { action: string; documentVersion: string; evidence: unknown };
  const ledger = (rows: Row[]) => ({ consentRecord: { findMany: async () => rows } }) as unknown as Parameters<typeof attestedStoreIds>[0];

  it('a grant of older words counts for nothing; a grant of the current words stands', async () => {
    for (const action of ['granted', 're_granted']) {
      expect(await attestedStoreIds(ledger([{ action, documentVersion: 'v0', evidence: { vendorId: 'store-1' } }]), 'owner-1', ['store-1']), action).toEqual(new Set());
      expect(await attestedStoreIds(ledger([{ action, documentVersion: FOOD_HANDLERS_VERSION, evidence: { vendorId: 'store-1' } }]), 'owner-1', ['store-1']), action).toEqual(new Set(['store-1']));
    }
  });
});

describe('[FOOD-PERMIT] the console never makes an unticked restaurant live', () => {
  const base = { suspensionSource: null, ownerAccountStatus: 'ACTIVE', subscription: null, feePause: feePausePredicate(false) };
  const goLive = (attested: boolean, required = true) => ({
    checklist: { complete: true }, disclosure: { engaged: false, complete: null, missing: [] }, publishedPhone: true,
    foodHandlers: { required, attested },
  }) as unknown as Parameters<typeof vendorActivationNext>[1];

  it('waiting for approval without the tick: refused, with what is missing', () => {
    expect(vendorActivationNext({ ...base, status: 'PENDING_APPROVAL' }, goLive(false))).toBe('NEEDS_FOOD_HANDLER_TICK');
    const refusal = vendorActivationRefusal('NEEDS_FOOD_HANDLER_TICK', 'Roti Hut', goLive(false));
    expect(refusal?.statusCode).toBe(409);
    expect(refusal?.code).toBe('FOOD_HANDLER_TICK_MISSING');
    expect(refusal?.message).toMatch(/Roti Hut/);
    expect(refusal?.message).toMatch(/food handler’s certificate/);
  });

  it('a suspended restaurant is not reinstated without it either', () => {
    expect(vendorActivationNext({ ...base, status: 'SUSPENDED', subscription: null }, goLive(false))).toBe('NEEDS_FOOD_HANDLER_TICK');
  });

  it('ticked, or not a registered restaurant: unchanged', () => {
    expect(vendorActivationNext({ ...base, status: 'PENDING_APPROVAL' }, goLive(true))).toBe('CAN_ACTIVATE');
    expect(vendorActivationNext({ ...base, status: 'PENDING_APPROVAL' }, goLive(false, false))).toBe('CAN_ACTIVATE');
    expect(vendorActivationNext({ ...base, status: 'ACTIVE' }, goLive(false))).toBe('LIVE');
  });
});

describe('[FOOD-PERMIT] the trust badge: a food handler’s certificate on file is said on the store page', () => {
  const block = (docTypes: string[]) => ({
    complete: true, missing: [], legalName: null, address: null, contact: null,
    licences: docTypes.map((docType) => ({ value: 'on file', source: 'RECORD', docType })),
    operator: { legalName: 'x', registeredAddress: 'x', supportEmail: 'x' }, compiledAt: new Date(0).toISOString(),
  }) as DisclosureBlock;
  const store = { mmgPayUrl: null, mmgNumber: null, refundRule: null };

  it('only from a current certificate record in the compiled block (the block holds VALID records only)', () => {
    expect(storefrontSeller(block([CERT, 'gra_restaurant_licence']), store).foodHandlerCertificate).toBe(true);
    expect(storefrontSeller(block(['gra_restaurant_licence']), store).foodHandlerCertificate).toBe(false);
    expect(storefrontSeller(block([]), store).foodHandlerCertificate).toBe(false);
  });
});
