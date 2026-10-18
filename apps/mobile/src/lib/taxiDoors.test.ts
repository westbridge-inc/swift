import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taxiDoorFor } from './taxiDoors';

// [Owner ruling 16 Oct 2026 — CUSTOMERS TAKE NO PHOTOS] A ride needs only the ID on file, so the one
// account gate the passenger can fix is the ID check. The server no longer sends a customer
// SELFIE_REQUIRED (#1554); this build opens no camera door for it and the customer stack has no
// Selfie screen. Partner selfie flows are untouched (root gate, go-online).

describe('taxiDoorFor', () => {
  it('maps the one fixable account gate, the ID check, to its door', () => {
    expect(taxiDoorFor('ID_VERIFICATION_REQUIRED')).toBe('identity');
  });

  it('opens no door for anything else — a photo request included', () => {
    for (const code of ['SELFIE_REQUIRED', 'NO_DRIVERS_NEARBY', 'STRIKE_RESTRICTED', 'VALIDATION_ERROR', '', null, undefined]) {
      expect(taxiDoorFor(code)).toBeNull();
    }
  });
});

describe('the taxi screen opens the ID door, and never a photo door', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('TaxiScreen opens the ID door for BOTH the ride request and the queue join', () => {
    const taxi = src('modules/movement/screens/TaxiScreen.tsx');
    // one mapping for the request's refusal, one for the queue join's
    expect(taxi.match(/taxiDoorFor\(/g)?.length).toBe(2);
    expect(taxi).toMatch(/joinQueue\.error/);
    expect(taxi).toMatch(/queueErrMsg \?/);
    expect(taxi.match(/navigate\?\.\('IdentityVerification'\)/g)?.length).toBe(2);
    expect(taxi).not.toMatch(/navigate\?\.\('Selfie'\)|Add your photo/);
  });

  it('the customer stack registers no Selfie screen', () => {
    const stack = src('navigation/CustomerStack.tsx');
    expect(stack).not.toMatch(/name="Selfie"|SelfieCaptureScreen/);
  });
});
