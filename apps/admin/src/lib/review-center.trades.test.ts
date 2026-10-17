import { describe, expect, it } from 'vitest';
import { docLabel, reviewNote } from './review-center';

// [TRADES · 13 Oct 2026; R15 · 15 Oct 2026] The service-trade documents opened at launch carry a plain
// label and a reviewer note saying what to check; a person decides every one. The held trades'
// documents (Town Clerk, ICAG, GRA practice, GCAA drone) are gone with them.
const TRADE_DOCS = ['pest_control_operator_licence', 'pesticide_applicator_certificate', 'eating_house_registration'];
/** [R15] checked again every January: the reviewer types the certificate's year. [owner 16 Oct] a store's yearly licences too. */
const CERTIFICATE_YEAR_DOCS = [
  'pest_control_operator_licence', 'eating_house_registration', 'food_handler_cert', 'gei_electrical_licence',
  'gra_restaurant_licence', 'sanitary_certificate', 'trade_licence',
];

describe('[TRADES] review console wording for service-trade documents', () => {
  it.each(TRADE_DOCS)('%s has a label and a reviewer note', (docType) => {
    expect(docLabel(docType)).not.toBe('Document');
    expect(reviewNote(docType, 'CUSTOMER')).toBeTruthy();
  });

  it.each(CERTIFICATE_YEAR_DOCS)('%s tells the reviewer to type the year it is for', (docType) => {
    expect(docLabel(docType)).not.toBe('Document');
    expect(reviewNote(docType, 'CUSTOMER')).toMatch(/Type the year it is for/);
  });

  it('a chef’s or caterer’s papers are Georgetown’s for now', () => {
    expect(reviewNote('food_handler_cert', 'CUSTOMER')).toMatch(/Mayor and City Council of Georgetown/);
    expect(reviewNote('eating_house_registration', 'CUSTOMER')).toMatch(/Outside Georgetown is not accepted yet/);
  });

  it('[owner 16 Oct] no machine-class note on any driver’s licence: the heavy-equipment operator is held', () => {
    expect(reviewNote('drivers_licence', 'CUSTOMER')).toBeNull();
    expect(reviewNote('drivers_licence', 'MOVER')).toBeNull();
  });

  it('[owner 16 Oct] a store’s yearly licences are re-checked every January, like a business name', () => {
    for (const docType of ['gra_restaurant_licence', 'sanitary_certificate', 'trade_licence']) {
      expect(reviewNote(docType, 'VENDOR_OWNER'), docType).toMatch(/checked again every January/);
    }
  });

  it('never asks a reviewer to accept a medical certificate', () => {
    expect(reviewNote('food_handler_cert', 'VENDOR_OWNER')).toMatch(/Never a medical certificate/);
  });

  it.each(['town_clerk_registration', 'town_clerk_shop_certificate', 'chartered_accountant_practising_certificate', 'gra_practice_certificate', 'drone_authorisation'])('%s (a held trade’s document) has no note', (docType) => {
    expect(reviewNote(docType, 'CUSTOMER')).toBeNull();
  });
});
