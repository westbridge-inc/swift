import { describe, expect, it } from 'vitest';
import { fareLockedFor, fareToSubmit } from './fare-locked';

describe('fareLockedFor', () => {
  it('locks when the board row declares MOBILE_MONEY', () => {
    expect(fareLockedFor({ paymentMethod: 'MOBILE_MONEY' }, {})).toBe(true);
  });

  it('stays unlocked when the board row declares CASH and the offer declares MOBILE_MONEY', () => {
    expect(fareLockedFor({ paymentMethod: 'CASH' }, { paymentMethod: 'MOBILE_MONEY' })).toBe(false);
  });

  it('locks a socket-only offer that declares MOBILE_MONEY', () => {
    expect(fareLockedFor(undefined, { paymentMethod: 'MOBILE_MONEY' })).toBe(true);
  });

  it('leaves a socket-only CASH offer unlocked', () => {
    expect(fareLockedFor(undefined, { paymentMethod: 'CASH' })).toBe(false);
  });

  it('falls back to an MMG offer when the board row payment method is null', () => {
    expect(fareLockedFor({ paymentMethod: null }, { paymentMethod: 'MOBILE_MONEY' })).toBe(true);
  });

  it('defaults to unlocked when neither source declares a payment method', () => {
    expect(fareLockedFor(undefined, {})).toBe(false);
  });
});

describe('fareToSubmit', () => {
  it('submits no fare when the fare is locked regardless of price', () => {
    expect(fareToSubmit(true, 100, 50)).toBeUndefined();
    expect(fareToSubmit(true, 100, 100)).toBeUndefined();
    expect(fareToSubmit(true, 100, 0)).toBeUndefined();
  });

  it('submits no fare when the unlocked price equals the market maximum', () => {
    expect(fareToSubmit(false, 100, 100)).toBeUndefined();
  });

  it('submits no fare when the price is zero', () => {
    expect(fareToSubmit(false, 100, 0)).toBeUndefined();
  });

  it('submits no fare when the market maximum is zero', () => {
    expect(fareToSubmit(false, 0, 50)).toBeUndefined();
  });

  it('submits an unlocked price strictly below the market maximum', () => {
    expect(fareToSubmit(false, 100, 60)).toBe(60);
  });
});
