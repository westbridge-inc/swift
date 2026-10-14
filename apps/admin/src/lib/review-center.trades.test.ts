import { describe, expect, it } from 'vitest';
import { docLabel, reviewNote } from './review-center';

// [TRADES · 13 Oct 2026] The service-trade documents opened at launch carry a plain
// label and a reviewer note saying what to check; a person decides every one.
const TRADE_DOCS = [
  'pest_control_operator_licence', 'pesticide_applicator_certificate',
  'chartered_accountant_practising_certificate', 'gra_practice_certificate',
  'eating_house_registration', 'town_clerk_registration', 'town_clerk_shop_certificate',
  'drone_authorisation',
];

describe('[TRADES] review console wording for service-trade documents', () => {
  it.each(TRADE_DOCS)('%s has a label and a reviewer note', (docType) => {
    expect(docLabel(docType)).not.toBe('Document');
    expect(reviewNote(docType, 'CUSTOMER')).toBeTruthy();
  });

  it('asks for the machine class only on a service provider’s driver’s licence', () => {
    expect(reviewNote('drivers_licence', 'CUSTOMER')).toMatch(/class covers the machine/);
    expect(reviewNote('drivers_licence', 'MOVER')).toBeNull();
  });

  it('never asks a reviewer to accept a medical certificate', () => {
    expect(reviewNote('food_handler_cert', 'VENDOR_OWNER')).toMatch(/Never a medical certificate/);
    expect(reviewNote('town_clerk_registration', 'CUSTOMER')).toMatch(/Never accept a medical certificate/);
  });
});
