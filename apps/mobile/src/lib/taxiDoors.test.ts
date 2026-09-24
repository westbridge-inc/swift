import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taxiDoorFor } from './taxiDoors';

// [E27] A signed-in customer no longer takes a selfie at the door of the app
// (no selfie merely to browse/order). Booking a taxi still needs one, so the
// ride request's SELFIE_REQUIRED must open the camera, the same way
// ID_VERIFICATION_REQUIRED opens the ID check.

describe('taxiDoorFor', () => {
  it('maps the two fixable account gates to their doors', () => {
    expect(taxiDoorFor('SELFIE_REQUIRED')).toBe('selfie');
    expect(taxiDoorFor('ID_VERIFICATION_REQUIRED')).toBe('identity');
  });

  it('opens no door for anything else', () => {
    for (const code of ['NO_DRIVERS_NEARBY', 'STRIKE_RESTRICTED', 'VALIDATION_ERROR', '', null, undefined]) {
      expect(taxiDoorFor(code)).toBeNull();
    }
  });
});

describe('the taxi screen wires the selfie door to a reachable screen', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('TaxiScreen navigates to Selfie on the selfie door', () => {
    const taxi = src('modules/movement/screens/TaxiScreen.tsx');
    expect(taxi).toMatch(/taxiDoorFor\(/);
    expect(taxi).toMatch(/navigate\?\.\('Selfie'\)/);
  });

  it('the customer stack registers the Selfie screen, so the door is not a dead end', () => {
    const stack = src('navigation/CustomerStack.tsx');
    expect(stack).toMatch(/<Stack\.Screen name="Selfie" component=\{SelfieCaptureScreen\} \/>/);
  });

  it('a pushed selfie screen goes back instead of signing out', () => {
    const selfie = src('screens/auth/SelfieCaptureScreen.tsx');
    expect(selfie).toMatch(/canGoBack/);
    expect(selfie).toMatch(/Not now/);
  });
});
