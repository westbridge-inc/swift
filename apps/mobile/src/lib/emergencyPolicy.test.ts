import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519';
import {
  BUNDLED_EMERGENCY_POLICIES, bundledPolicyFor, emergencyCounters, locationAccuracyBand, parseServedPolicy, policyFor, recordEmergencyDial,
  recordSosLocation, recordSosTransition, resetEmergencyCountersForTests, resolveEmergencyDial, telUrl, type EmergencyPolicy,
} from './emergencyPolicy';

// ---------------------------------------------------------------------------
// [MOB-018] The emergency dial is a market fact, resolved one way everywhere:
// a verified number auto-dials, an unverified candidate asks, nothing
// trustworthy is a manual sheet — and no screen hard-codes a number.
// ---------------------------------------------------------------------------

// [AUD-G7-023] A throwaway Ed25519 key drawn for this file, pinned only here.
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const SECRET = ed25519.utils.randomPrivateKey();
const PINS = [{ kid: 'ep1-1111111111111111', ed25519: hex(ed25519.getPublicKey(SECRET)) }];
const signedEnvelope = (payload: string): Record<string, unknown> => ({
  version: 2, alg: 'Ed25519', kid: PINS[0]!.kid, payload,
  signature: hex(ed25519.sign(new TextEncoder().encode(`swift.emergency-policy.v2\u0000Ed25519\u0000${PINS[0]!.kid}\u0000${payload}`), SECRET)),
});
const TT_PAYLOAD = (now: number) =>
  `{"country":"TT","expiresAt":${now + 3_600_000},"issuedAt":${now},"numbers":{"ambulance":{"number":"811","verified":false},"police":{"number":"999","verified":true}},"v":2}`;

/** What the API serves: the v1 body builds 9-11 read, plus the Ed25519 envelope build 12+ trusts. */
const served = (over: Partial<Record<string, unknown>> = {}, now = 1_000_000): Record<string, unknown> => ({
  version: 1,
  country: 'TT',
  numbers: { police: { number: '999', verified: true }, ambulance: { number: '811', verified: false } },
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 3_600_000).toISOString(),
  signature: { alg: 'HMAC-SHA256', kid: 'abcd1234', value: 'f'.repeat(64) },
  envelope: signedEnvelope(TT_PAYLOAD(now)),
  ...over,
});

beforeEach(() => resetEmergencyCountersForTests());

describe('the bundled fallback', () => {
  it('names Guyana’s three owner-confirmed numbers as verified and every other number as an unverified candidate', () => {
    // Owner confirmation, 5 Oct 2026: police 911, fire 912, ambulance 913.
    expect(BUNDLED_EMERGENCY_POLICIES['GY']).toEqual({
      police: { number: '911', verified: true }, fire: { number: '912', verified: true }, ambulance: { number: '913', verified: true },
    });
    for (const [country, numbers] of Object.entries(BUNDLED_EMERGENCY_POLICIES)) {
      for (const [service, entry] of Object.entries(numbers)) {
        expect(entry.number, `${country}.${service}`).toMatch(/^\+?[0-9]{2,15}$/);
        if (country !== 'GY') expect(entry.verified, `${country}.${service} must stay unverified until ops verifies it`).toBe(false);
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

describe('[AUD-G7-023] the served policy is trusted only through its verified signature, never by shape', () => {
  it('accepts the API payload by its Ed25519 envelope under a pinned key, for the market asked for', () => {
    const ok = parseServedPolicy(served(), 'TT', 1_000_000, PINS);
    expect(ok).toMatchObject({ country: 'TT', source: 'server', numbers: { police: { number: '999', verified: true }, ambulance: { number: '811', verified: false } } });
    expect(Date.parse(ok!.expiresAt!)).toBe(1_000_000 + 3_600_000);
  });

  it('a shape-only policy — exactly what builds 9-11 accept, with an HMAC-shaped signature nobody can check — is not a policy', () => {
    const shapeOnly = served();
    delete shapeOnly['envelope'];
    expect(parseServedPolicy(shapeOnly, 'TT', 1_000_000, PINS)).toBeNull();
    // The shipped pins never trust a key drawn in a test.
    expect(parseServedPolicy(served(), 'TT', 1_000_000)).toBeNull();
  });

  it('the v1 numbers beside the envelope are never read; a change to the signed numbers is refused', () => {
    const forgedV1 = served({ numbers: { police: { number: '112', verified: true } } });
    expect(parseServedPolicy(forgedV1, 'TT', 1_000_000, PINS)?.numbers.police).toEqual({ number: '999', verified: true });
    const env = served()['envelope'] as Record<string, string>;
    const tampered = served({ envelope: { ...env, payload: (env['payload'] as string).replace('"999"', '"112"') } });
    expect(parseServedPolicy(tampered, 'TT', 1_000_000, PINS)).toBeNull();
  });

  it('refuses every malformed, expired or foreign variant', () => {
    const bad: Array<[string, unknown, string?, number?]> = [
      ['null', null], ['string', 'policy'], ['array', []],
      ['another market than the one asked for', served(), 'GY'],
      ['no market asked for', served(), ''],
      ['expired', served(), 'TT', 1_000_000 + 3_600_000],
      ['envelope missing', served({ envelope: undefined })],
      ['envelope with another algorithm', served({ envelope: { ...(served()['envelope'] as object), alg: 'HMAC-SHA256' } })],
      ['envelope a string', served({ envelope: 'signed' })],
    ];
    for (const [label, raw, country, now] of bad) expect(parseServedPolicy(raw, country ?? 'TT', now ?? 1_000_000, PINS), label).toBeNull();
  });
});

describe('[AUD-G7-023] a pin with notAfter (the staging pin) stops being trusted on its own', () => {
  it('its policy is in force until notAfter, then the market falls back to the bundle; a pin without notAfter is untouched', () => {
    const END = 1_000_000 + 1_800_000;
    const expiring = [{ ...PINS[0]!, notAfter: END }];
    const held = parseServedPolicy(served(), 'TT', 1_000_000, expiring);
    expect(Date.parse(held!.expiresAt!), 'held no later than notAfter').toBe(END);
    expect(policyFor('TT', held, END - 1)?.source).toBe('server');
    expect(policyFor('TT', held, END)).toEqual(bundledPolicyFor('TT'));
    expect(parseServedPolicy(served(), 'TT', END, expiring), 'refused at notAfter').toBeNull();
    // The same envelope under a pin without notAfter (production) keeps its signed hour.
    const production = parseServedPolicy(served(), 'TT', 1_000_000, PINS);
    expect(policyFor('TT', production, END)?.source).toBe('server');
  });
});

describe('precedence: the server’s policy for THIS market wins; then the bundle; then nothing', () => {
  it('uses the served policy only for its own market and only while unexpired', () => {
    const tt = parseServedPolicy(served(), 'TT', 1_000_000, PINS)!;
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
    expect(resolveEmergencyDial(bundledPolicyFor('GY'), 'fire')).toEqual({ kind: 'auto', country: 'GY', number: '912', service: 'fire', source: 'bundled' });
    expect(resolveEmergencyDial(bundledPolicyFor('GY'), 'ambulance')).toEqual({ kind: 'auto', country: 'GY', number: '913', service: 'ambulance', source: 'bundled' });
    expect(resolveEmergencyDial(bundledPolicyFor('TT'))).toEqual({ kind: 'confirm', country: 'TT', number: '999', service: 'police', source: 'bundled' });
    expect(resolveEmergencyDial(null)).toEqual({ kind: 'manual', country: null });
    const noPolice: EmergencyPolicy = { country: 'ZZ', numbers: { fire: { number: '112', verified: true } }, source: 'server' };
    expect(resolveEmergencyDial(noPolice)).toEqual({ kind: 'manual', country: 'ZZ' });
    const servedTT = parseServedPolicy(served(), 'TT', 1_000_000, PINS)!;
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
