import { describe, expect, it } from 'vitest';
import { mmgStorePaymentNote, parseMmgStorePayment } from './mmgStorePayment';

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The order screen shows the store's MMG number only in its exact shape.
const OK = {
  payTo: 'STORE_NUMBER', provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', recipientName: 'Number Diner',
  number: '+5926001234', numberDisplay: '+592 600 1234', amount: 2800, currencyCode: 'GYD',
  instruction: "Pay $2,800 by MMG to Number Diner's MMG number +592 600 1234.",
};

describe('parseMmgStorePayment', () => {
  it('accepts the server shape as-is', () => {
    expect(parseMmgStorePayment(OK)).toEqual(OK);
  });

  it.each([
    ['absent', null],
    ['an old pay-link action', { kind: 'OPEN_EXTERNAL_URL', url: 'https://pay.example.com/x' }],
    ['a landline', { ...OK, number: '+5922251234', numberDisplay: '+592 225 1234', instruction: 'Pay to +592 225 1234.' }],
    ['a display that is not the number', { ...OK, numberDisplay: '+592 600 9999' }],
    ['an instruction that names another number', { ...OK, instruction: "Pay $2,800 by MMG to Number Diner's MMG number +592 600 9999." }],
    ['no amount', { ...OK, amount: 0 }],
    ['another rail', { ...OK, payTo: 'LINK' }],
    ['no store name', { ...OK, recipientName: ' ' }],
  ])('refuses %s', (_label, value) => {
    expect(parseMmgStorePayment(value)).toBeNull();
  });

  it('says what happens next, and that Swift never holds the money', () => {
    expect(mmgStorePaymentNote(OK as never)).toBe('Send it in your MMG app. Number Diner marks your order paid when the money arrives. Swift never holds this money.');
  });
});
