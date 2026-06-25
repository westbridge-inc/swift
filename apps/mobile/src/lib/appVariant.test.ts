import { describe, it, expect, afterEach } from 'vitest';
import { getAppVariant, partnerStackKey } from './appVariant';

const ORIGINAL = process.env['EXPO_PUBLIC_APP_VARIANT'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['EXPO_PUBLIC_APP_VARIANT'];
  else process.env['EXPO_PUBLIC_APP_VARIANT'] = ORIGINAL;
});

describe('getAppVariant', () => {
  it('defaults to customer when unset', () => {
    delete process.env['EXPO_PUBLIC_APP_VARIANT'];
    expect(getAppVariant()).toBe('customer');
  });

  it('is partner only for the exact "partner" value (case-sensitive)', () => {
    process.env['EXPO_PUBLIC_APP_VARIANT'] = 'partner';
    expect(getAppVariant()).toBe('partner');
    process.env['EXPO_PUBLIC_APP_VARIANT'] = 'PARTNER';
    expect(getAppVariant()).toBe('customer');
    process.env['EXPO_PUBLIC_APP_VARIANT'] = 'customer';
    expect(getAppVariant()).toBe('customer');
  });
});

describe('partnerStackKey', () => {
  it('maps earner roles to their stack', () => {
    expect(partnerStackKey('MOVER')).toBe('mover');
    expect(partnerStackKey('RIDER')).toBe('mover');
    expect(partnerStackKey('DRIVER')).toBe('mover');
    expect(partnerStackKey('VENDOR_OWNER')).toBe('vendor');
  });

  it('sends customer / unknown / missing roles to onboarding', () => {
    expect(partnerStackKey('CUSTOMER')).toBe('onboarding');
    expect(partnerStackKey(undefined)).toBe('onboarding');
    expect(partnerStackKey(null)).toBe('onboarding');
    expect(partnerStackKey('SOMETHING_ELSE')).toBe('onboarding');
  });
});
