import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// [Owner ruling 16 Oct 2026 — CUSTOMERS TAKE NO PHOTOS] The server no longer sends a customer
// SELFIE_REQUIRED (#1554); this build opens no camera door for it and the customer stack has no
// Selfie screen. Partner selfie flows are untouched (root gate, go-online).
// [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE] A ride no longer needs the ID on file
// either: the server never answers a ride or a queue join with ID_VERIFICATION_REQUIRED, so the
// "Add your ID" doors (and taxiDoors.ts, which mapped that code to them) are gone. A refusal the
// passenger meets still shows its own words — never a silent tap.

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('the taxi screen opens no ID door and no photo door', () => {
  it('TaxiScreen asks for neither an ID nor a photo', () => {
    const taxi = src('modules/movement/screens/TaxiScreen.tsx');
    expect(taxi).not.toMatch(/IdentityVerification/);
    expect(taxi).not.toMatch(/Add your ID/);
    expect(taxi).not.toMatch(/taxiDoorFor|ID_VERIFICATION_REQUIRED/);
    expect(taxi).not.toMatch(/navigate\?\.\('Selfie'\)|Add your photo/);
    expect(existsSync(join(__dirname, 'taxiDoors.ts'))).toBe(false);
  });

  it('a refused queue join still shows the server\'s words', () => {
    const taxi = src('modules/movement/screens/TaxiScreen.tsx');
    expect(taxi).toMatch(/joinQueue\.error/);
    expect(taxi).toMatch(/queueErrMsg \?/);
  });

  it('the customer stack registers no Selfie screen', () => {
    const stack = src('navigation/CustomerStack.tsx');
    expect(stack).not.toMatch(/name="Selfie"|SelfieCaptureScreen/);
  });
});
