import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_ACCURACY_M,
  MAX_FIX_AGE_MS,
  acceptFix,
  addressKey,
  canSave,
  placeMatches,
  type SelectedPlace,
} from './place';

// ---------------------------------------------------------------------------
// [W-08] S0 location integrity. The address form paired typed text with
// wherever the DEVICE was when Save was pressed, and nothing ever checked that
// the two described the same place. Add your home address from the office and
// the delivery fee, the rider's route and the courier's destination are all the
// office — while every screen says home.
// ---------------------------------------------------------------------------

const HOME = { addressLine1: '42 Lamaha Street', city: 'Georgetown' };
const OFFICE = { addressLine1: '9 Camp Road', city: 'Georgetown' };
const NOW = 1_700_000_000_000;

const goodFix = (over: Partial<Parameters<typeof acceptFix>[0]> = {}) =>
  acceptFix({ key: addressKey(HOME), lat: 6.8013, lng: -58.1551, accuracyM: 12, timestamp: NOW, now: NOW, ...over });

describe('[W-08] a fix is accepted only if it is good enough to send a rider to', () => {
  it('accepts a precise, current fix and keeps the device’s own accuracy', () => {
    const r = goodFix();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.place).toMatchObject({ lat: 6.8013, lng: -58.1551, accuracyM: 12, source: 'DEVICE' });
      expect(r.place.addressKey).toBe(addressKey(HOME));
    }
  });

  it('refuses a fix too rough to be a doorstep', () => {
    const r = goodFix({ accuracyM: MAX_ACCURACY_M + 1 });
    expect(r).toMatchObject({ ok: false, reason: 'INACCURATE' });
    // the number the app used to discard entirely is now in the message
    if (!r.ok) expect(r.message).toMatch(/251 m/);
  });

  it('a ±5 km cell-tower fix is not a delivery address', () => {
    expect(goodFix({ accuracyM: 5000 })).toMatchObject({ ok: false, reason: 'INACCURATE' });
  });

  it('an UNKNOWN accuracy is not a good one', () => {
    for (const bad of [null, undefined, NaN, 0, -1, 'ten' as unknown as number]) {
      expect(goodFix({ accuracyM: bad as number }), String(bad)).toMatchObject({ ok: false, reason: 'NO_FIX' });
    }
  });

  it('refuses a stale reading — that is where you WERE', () => {
    expect(goodFix({ now: NOW + MAX_FIX_AGE_MS + 1 })).toMatchObject({ ok: false, reason: 'STALE' });
    expect(goodFix({ now: NOW + MAX_FIX_AGE_MS - 1 }).ok).toBe(true);
  });

  it('refuses null island and impossible coordinates', () => {
    expect(goodFix({ lat: 0, lng: 0 })).toMatchObject({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(goodFix({ lat: 91, lng: 0 })).toMatchObject({ ok: false, reason: 'OUT_OF_RANGE' });
    expect(goodFix({ lat: 6.8, lng: NaN })).toMatchObject({ ok: false, reason: 'OUT_OF_RANGE' });
  });
});

describe('[W-08] a place belongs to the address it was captured for', () => {
  const captured = (): SelectedPlace => {
    const r = goodFix();
    if (!r.ok) throw new Error('fixture');
    return r.place;
  };

  it('the defect, pinned: a fix taken at the office does not describe home', () => {
    const atOffice = acceptFix({ key: addressKey(OFFICE), lat: 6.81, lng: -58.16, accuracyM: 10, timestamp: NOW, now: NOW });
    expect(atOffice.ok).toBe(true);
    if (atOffice.ok) {
      // the old page would have saved this point under the home address
      expect(placeMatches(atOffice.place, HOME)).toBe(false);
      expect(canSave(atOffice.place, HOME)).toBe(false);
    }
  });

  it('editing the address invalidates the capture', () => {
    const place = captured();
    expect(placeMatches(place, HOME)).toBe(true);
    expect(placeMatches(place, { ...HOME, addressLine1: '43 Lamaha Street' })).toBe(false);
    expect(placeMatches(place, { ...HOME, city: 'New Amsterdam' })).toBe(false);
  });

  it('case and spacing are not a different place', () => {
    const place = captured();
    expect(placeMatches(place, { addressLine1: '  42 LAMAHA   Street ', city: ' georgetown ' })).toBe(true);
  });

  it('nothing can be saved without a capture', () => {
    expect(canSave(null, HOME)).toBe(false);
  });

  it('nothing can be saved with an empty address, capture or not', () => {
    const place = captured();
    expect(canSave(place, { addressLine1: '', city: 'Georgetown' })).toBe(false);
    expect(canSave(place, { addressLine1: '42 Lamaha Street', city: '  ' })).toBe(false);
  });

  it('a matching capture saves', () => {
    expect(canSave(captured(), HOME)).toBe(true);
  });
});

describe('[W-08] the address page enforces it', () => {
  // Strip comments first. Both files EXPLAIN the defect they replaced —
  // geolocate.ts names the removed "(6.8013, -58.1551)" fallback in its header
  // — so a census over raw text grades the explanation, not the code.
  const code_ = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const code = code_(readFileSync(join(process.cwd(), 'src/app/(app)/order/location/page.tsx'), 'utf8'));
  const geo = code_(readFileSync(join(process.cwd(), 'src/lib/geolocate.ts'), 'utf8'));

  it('editing the address clears the captured place', () => {
    expect(code).toMatch(/if \(place && !placeMatches\(place, next\)\) setPlace\(null\)/);
  });

  it('save is impossible without a place bound to the text being saved', () => {
    expect(code).toMatch(/if \(!canSave\(place, form\)\) return;/);
    expect(code).toMatch(/disabled=\{busy \|\| !ready\}/);
  });

  it('the coordinates saved are the captured ones, never a fresh unrelated fix', () => {
    expect(code).toMatch(/latitude: place!\.lat/);
    expect(code).toMatch(/longitude: place!\.lng/);
    // the old shape: ask the browser inside save() and pair it with the form
    expect(code).not.toMatch(/const coords = await currentCoords/);
  });

  it('a failed address list is not "you have no addresses"', () => {
    expect(code).not.toMatch(/getAddresses\(\)\.catch\(/);
    expect(code).toMatch(/<DataUnavailable/);
    // and it must not decide "first address" from a list that failed to load
    expect(code).toMatch(/isDefault: addresses !== null && addresses\.length === 0/);
  });

  it('the accuracy the browser reports is carried, not discarded', () => {
    expect(geo).toMatch(/accuracyM: typeof p\.coords\.accuracy === 'number'/);
    expect(code).toMatch(/accuracyM: fix\.accuracyM/);
    // currentCoords still exists for other callers, and still has no fallback
    expect(geo).toMatch(/export function currentCoords/);
    expect(geo).not.toMatch(/6\.8013, -58\.1551\D*\)/);
  });
});
