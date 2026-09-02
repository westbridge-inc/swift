import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUNDLED_EMERGENCY_POLICIES, bundledPolicyFor, emergencyCounters, locationAccuracyBand, parseServedPolicy, policyFor, recordEmergencyDial,
  recordSosLocation, recordSosTransition, resetEmergencyCountersForTests, resolveEmergencyDial, telUrl, type EmergencyPolicy,
} from './emergencyPolicy';

// ---------------------------------------------------------------------------
// [MOB-018] The emergency dial is a market fact, resolved one way everywhere:
// a verified number auto-dials, an unverified candidate asks, nothing
// trustworthy is a manual sheet — and no screen hard-codes a number.
// ---------------------------------------------------------------------------

const served = (over: Partial<Record<string, unknown>> = {}, now = 1_000_000): Record<string, unknown> => ({
  version: 1,
  country: 'TT',
  numbers: { police: { number: '999', verified: true }, ambulance: { number: '811', verified: false } },
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 3_600_000).toISOString(),
  signature: { alg: 'HMAC-SHA256', kid: 'abcd1234', value: 'f'.repeat(64) },
  ...over,
});

beforeEach(() => resetEmergencyCountersForTests());

describe('the bundled fallback', () => {
  it('names Guyana’s police number as the one verified entry and every other number as an unverified candidate', () => {
    expect(BUNDLED_EMERGENCY_POLICIES['GY']?.police).toEqual({ number: '911', verified: true });
    for (const [country, numbers] of Object.entries(BUNDLED_EMERGENCY_POLICIES)) {
      for (const [service, entry] of Object.entries(numbers)) {
        expect(entry.number, `${country}.${service}`).toMatch(/^\+?[0-9]{2,15}$/);
        if (!(country === 'GY' && service === 'police')) expect(entry.verified, `${country}.${service} must stay unverified until ops verifies it`).toBe(false);
      }
    }
    expect(Object.isFrozen(BUNDLED_EMERGENCY_POLICIES)).toBe(true);
  });
  it('resolves by country code, case-insensitively, and knows nothing about markets it does not carry', () => {
    expect(bundledPolicyFor('gy')?.source).toBe('bundled');
    expect(bundledPolicyFor('GY')?.numbers.police?.number).toBe('911');
    expect(bundledPolicyFor('XX')).toBeNull();
    expect(bundledPolicyFor(null)).toBeNull();
    expect(bundledPolicyFor(undefined)).toBeNull();
  });
});

describe('the served policy is validated, never trusted by shape alone', () => {
  it('accepts the API payload and refuses every malformed or expired variant', () => {
    const ok = parseServedPolicy(served(), 1_000_000);
    expect(ok).toMatchObject({ country: 'TT', source: 'server', numbers: { police: { number: '999', verified: true }, ambulance: { number: '811', verified: false } } });
    const bad: Array<[string, unknown]> = [
      ['null', null], ['string', 'policy'], ['array', []],
      ['version 2', served({ version: 2 })],
      ['country lowercase', served({ country: 'tt' })],
      ['no expiry', served({ expiresAt: undefined })],
      ['expired', served({ expiresAt: new Date(999_000).toISOString() })],
      ['no signature', served({ signature: undefined })],
      ['signature without kid', served({ signature: { alg: 'HMAC-SHA256', value: 'x' } })],
      ['numbers array', served({ numbers: [] })],
      ['no service', served({ numbers: {} })],
      ['letters in a number', served({ numbers: { police: { number: '9-1-1', verified: true } } })],
      ['verified not boolean', served({ numbers: { police: { number: '911', verified: 'yes' } } })],
      ['service not an object', served({ numbers: { police: '911' } })],
    ];
    for (const [label, raw] of bad) expect(parseServedPolicy(raw, 1_000_000), label).toBeNull();
  });
});

describe('precedence: the server’s policy for THIS market wins; then the bundle; then nothing', () => {
  it('uses the served policy only for its own market and only while unexpired', () => {
    const tt = parseServedPolicy(served(), 1_000_000)!;
    expect(policyFor('TT', tt, 1_000_000)?.source).toBe('server');
    expect(policyFor('GY', tt, 1_000_000)?.source).toBe('bundled'); // served is for TT, not GY
    expect(policyFor('TT', tt, 5_000_000)?.source).toBe('bundled'); // expired → the bundle's unverified TT candidates
    expect(policyFor('XX', tt, 1_000_000)).toBeNull();
    expect(policyFor(null, null)).toBeNull();
  });
});

describe('one resolution for every SOS surface', () => {
  it('a verified number auto-dials; an unverified candidate asks; nothing trustworthy is a manual sheet', () => {
    expect(resolveEmergencyDial(bundledPolicyFor('GY'))).toEqual({ kind: 'auto', country: 'GY', number: '911', service: 'police', source: 'bundled' });
    expect(resolveEmergencyDial(bundledPolicyFor('GY'), 'fire')).toEqual({ kind: 'confirm', country: 'GY', number: '912', service: 'fire', source: 'bundled' });
    expect(resolveEmergencyDial(bundledPolicyFor('TT'))).toEqual({ kind: 'confirm', country: 'TT', number: '999', service: 'police', source: 'bundled' });
    expect(resolveEmergencyDial(null)).toEqual({ kind: 'manual', country: null });
    const noPolice: EmergencyPolicy = { country: 'ZZ', numbers: { fire: { number: '112', verified: true } }, source: 'server' };
    expect(resolveEmergencyDial(noPolice)).toEqual({ kind: 'manual', country: 'ZZ' });
    const servedTT = parseServedPolicy(served(), 1_000_000)!;
    expect(resolveEmergencyDial(servedTT)).toMatchObject({ kind: 'auto', number: '999', source: 'server' });
  });
  it('a tel: URL carries digits and a leading + only', () => {
    expect(telUrl('911')).toBe('tel:911');
    expect(telUrl('+1 868 999')).toBe('tel:+1868999');
    expect(telUrl('9;1;1')).toBe('tel:911');
  });
});

describe('the counters carry markets, kinds, transitions and accuracy bands — never a coordinate', () => {
  it('counts dial decisions, transition mismatches and location evidence bands', () => {
    recordEmergencyDial(resolveEmergencyDial(bundledPolicyFor('GY')));
    recordEmergencyDial(resolveEmergencyDial(bundledPolicyFor('TT')));
    recordEmergencyDial(resolveEmergencyDial(null));
    recordSosTransition('ACTIVE', 'UNKNOWN');
    recordSosLocation(locationAccuracyBand({ accuracyM: 12 }));
    recordSosLocation(locationAccuracyBand({ accuracyM: 900 }));
    recordSosLocation(locationAccuracyBand({}));
    recordSosLocation(locationAccuracyBand(undefined));
    expect(emergencyCounters()).toEqual({
      dial: { 'GY:auto:bundled': 1, 'TT:confirm:bundled': 1, 'none:manual': 1 },
      transition: { 'ACTIVE->UNKNOWN': 1 },
      location: { under_50m: 1, over_250m: 1, unknown_accuracy: 1, none: 1 },
    });
    expect(JSON.stringify(emergencyCounters())).not.toMatch(/6\.8|-58/);
  });
});

describe('no screen hard-codes an emergency number any more', () => {
  it('the only literal emergency numbers in the app live in the bundled policy', () => {
    const files = ['../modules/safety/SosCeremony.tsx', '../modules/movement/screens/TaxiScreen.tsx', '../modules/mover/screens/ActiveJobScreen.tsx'];
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/tel:9\d\d/);
      expect(src, f).not.toMatch(/'tel:911'|"tel:911"|`tel:911`/);
    }
  });
});
