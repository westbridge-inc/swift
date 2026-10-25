import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { verifyEmergencyEnvelope, MAX_EMERGENCY_POLICY_CLOCK_AHEAD_MS, MAX_EMERGENCY_POLICY_LIFETIME_MS } from './emergencyPolicySignature';
import { EMERGENCY_POLICY_PINS, type EmergencyPolicyPin } from './emergencyPolicyPins';

// ---------------------------------------------------------------------------
// [AUD-G7-023 · board row 202] A served emergency number is trusted only when
// its Ed25519 signature verifies under a key pinned in this app, for the market
// asked for, inside its lifetime. Keys are drawn fresh inside this file; the
// one fixed vector is the API's own output (apps/api emergency-policy-
// signature.test.ts), proving the two implementations agree byte for byte.
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const HOUR = 3_600_000;

interface TestKey { secret: Uint8Array; pin: EmergencyPolicyPin }
function testKey(kid: string): TestKey {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, pin: { kid, ed25519: hex(ed25519.getPublicKey(secret)) } };
}

/** The signed text, spelled out here independently of the code under test. */
function signText(secret: Uint8Array, kid: string, payload: string): string {
  return hex(ed25519.sign(new TextEncoder().encode(`swift.emergency-policy.v2\u0000Ed25519\u0000${kid}\u0000${payload}`), secret));
}

const GY_NUMBERS = '{"ambulance":{"number":"913","verified":true},"fire":{"number":"912","verified":true},"police":{"number":"911","verified":true}}';
const payloadFor = (o: { country?: string; issuedAt?: number; expiresAt?: number; numbers?: string } = {}): string =>
  `{"country":"${o.country ?? 'GY'}","expiresAt":${o.expiresAt ?? NOW + 24 * HOUR},"issuedAt":${o.issuedAt ?? NOW},"numbers":${o.numbers ?? GY_NUMBERS},"v":2}`;

function envelope(key: TestKey, payload = payloadFor(), over: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 2, alg: 'Ed25519', kid: key.pin.kid, payload, signature: signText(key.secret, key.pin.kid, payload), ...over };
}

const A = testKey('ep1-aaaaaaaaaaaaaaaa');
const B = testKey('ep1-bbbbbbbbbbbbbbbb');
const verify = (raw: unknown, country = 'GY', now = NOW, pins: readonly EmergencyPolicyPin[] = [A.pin]) => verifyEmergencyEnvelope(raw, { country, now, pins });

describe('[AUD-G7-023] the phone checks the signature, not the shape', () => {
  it('accepts byte-for-byte what the API signs (the cross-implementation vector)', () => {
    const API_PIN = { kid: 'ep1-4d4fac578075383c', ed25519: '037e2b5619f0efd7d6edf60c4ad5c026660b1ef6880e68546b2c9f258d25cba6' };
    const API_ENVELOPE = {
      version: 2,
      alg: 'Ed25519',
      kid: 'ep1-4d4fac578075383c',
      payload: '{"country":"GY","expiresAt":1792238400000,"issuedAt":1792152000000,"numbers":{"ambulance":{"number":"913","verified":true},"fire":{"number":"912","verified":true},"police":{"number":"911","verified":true}},"v":2}',
      signature: 'cab80682f19a8a329ac2f05e739ad8a1b41590dd73b46d8a59cefeeaddb34785ce79c4bcdb177f76ac143092e489d0d55494be6591a030f253234dd87c885905',
    };
    expect(verify(API_ENVELOPE, 'GY', NOW, [API_PIN])).toEqual({
      kid: 'ep1-4d4fac578075383c', country: 'GY', issuedAt: 1792152000000, expiresAt: 1792238400000,
      numbers: { ambulance: { number: '913', verified: true }, fire: { number: '912', verified: true }, police: { number: '911', verified: true } },
    });
    // One changed character anywhere and it is not a policy.
    expect(verify({ ...API_ENVELOPE, signature: `${API_ENVELOPE.signature.slice(0, -1)}4` }, 'GY', NOW, [API_PIN])).toBeNull();
    expect(verify({ ...API_ENVELOPE, payload: API_ENVELOPE.payload.replace('"911"', '"999"') }, 'GY', NOW, [API_PIN])).toBeNull();
  });

  it('accepts an authentic envelope from a pinned key and hands back frozen facts', () => {
    const facts = verify(envelope(A));
    expect(facts).toMatchObject({ kid: A.pin.kid, country: 'GY', issuedAt: NOW, numbers: { police: { number: '911', verified: true } } });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts?.numbers)).toBe(true);
    expect(Object.isFrozen(facts?.numbers.police)).toBe(true);
    // Either of two pinned keys (a rotation window) verifies its own envelopes.
    expect(verify(envelope(B), 'GY', NOW, [A.pin, B.pin])?.kid).toBe(B.pin.kid);
  });

  it('refuses a tampered number or flag, a forged or foreign signature, an unknown key and a missing envelope', () => {
    const good = envelope(A);
    const cases: Array<[string, unknown, ReadonlyArray<EmergencyPolicyPin>?]> = [
      ['no envelope at all', undefined],
      ['null', null],
      ['police number changed after signing', { ...good, payload: (good['payload'] as string).replace('"911"', '"999"') }],
      ['fire flipped to unverified after signing', { ...good, payload: (good['payload'] as string).replace('"912","verified":true', '"912","verified":false') }],
      ['signature from a key this app does not pin, under a pinned kid', envelope({ secret: B.secret, pin: { ...B.pin, kid: A.pin.kid } })],
      ['kid nobody pinned', envelope(B)],
      ['no pins at all (the shipped default)', good, EMERGENCY_POLICY_PINS],
      ['the right key pinned under another kid', good, [{ kid: 'ep1-cccccccccccccccc', ed25519: A.pin.ed25519 }]],
      ['a malformed pin', good, [{ kid: A.pin.kid, ed25519: 'zz' }]],
      ['a shape-only signature (what builds 9-11 accepted)', { ...good, signature: 'f'.repeat(128) }],
      ['signature too short', { ...good, signature: (good['signature'] as string).slice(2) }],
      ['signature in upper case', { ...good, signature: (good['signature'] as string).toUpperCase() }],
      ['kid swapped after signing', { ...good, kid: 'ep1-dddddddddddddddd' }, [A.pin, { kid: 'ep1-dddddddddddddddd', ed25519: A.pin.ed25519 }]],
      ['another algorithm', { ...good, alg: 'ed25519' }],
      ['another version', { ...good, version: 3 }],
      ['an extra envelope field', { ...good, publicKey: A.pin.ed25519 }],
      ['a missing envelope field', { version: 2, alg: 'Ed25519', kid: A.pin.kid, payload: good['payload'] }],
      ['an array', [good]],
    ];
    for (const [label, raw, pins] of cases) expect(verify(raw, 'GY', NOW, pins ?? [A.pin]), label).toBeNull();
  });

  it('refuses a validly signed payload that is not exactly the canonical policy', () => {
    const signed = (payload: string) => envelope(A, payload);
    const cases: Array<[string, string]> = [
      ['spaces', payloadFor().replace('"country":"GY"', '"country": "GY"')],
      ['keys reordered', `{"v":2,"country":"GY","expiresAt":${NOW + HOUR},"issuedAt":${NOW},"numbers":${GY_NUMBERS}}`],
      ['a duplicate key', payloadFor().replace('"country":"GY"', '"country":"TT","country":"GY"')],
      ['an extra field', payloadFor().replace('"v":2', '"v":2,"z":1')],
      ['version 1 inside', payloadFor().replace('"v":2', '"v":1')],
      ['an unknown service', payloadFor({ numbers: '{"coastguard":{"number":"914","verified":true}}' })],
      ['no service', payloadFor({ numbers: '{}' })],
      ['letters in a number', payloadFor({ numbers: '{"police":{"number":"9-1-1","verified":true}}' })],
      ['verified as a string', payloadFor({ numbers: '{"police":{"number":"911","verified":"true"}}' })],
      ['an extra field on a number', payloadFor({ numbers: '{"police":{"number":"911","verified":true,"note":"x"}}' })],
      ['a fractional time', payloadFor({ issuedAt: NOW + 0.5 })],
      ['lowercase country', payloadFor({ country: 'gy' })],
      ['not JSON', 'police=911'],
      ['too long', payloadFor().replace('"v":2', `"v":2,"pad":"${'x'.repeat(2_100)}"`)],
      ['non-ASCII', payloadFor().replace('"GY"', '"GÜ"')],
    ];
    for (const [label, payload] of cases) expect(verify(signed(payload)), label).toBeNull();
  });

  it('binds the market asked for and the time: another market, expired, issued in the future or living too long is refused', () => {
    expect(verify(envelope(A, payloadFor({ country: 'TT' })), 'GY')).toBeNull();
    expect(verify(envelope(A, payloadFor({ country: 'TT' })), 'TT')?.country).toBe('TT');
    expect(verify(envelope(A), 'gy')).toBeNull(); // the caller passes the normalized market; nothing is guessed here
    expect(verify(envelope(A, payloadFor({ issuedAt: NOW - 2 * HOUR, expiresAt: NOW }))), 'expired exactly now').toBeNull();
    expect(verify(envelope(A, payloadFor({ issuedAt: NOW - 2 * HOUR, expiresAt: NOW + 1 })))).not.toBeNull();
    expect(verify(envelope(A, payloadFor({ issuedAt: NOW + MAX_EMERGENCY_POLICY_CLOCK_AHEAD_MS + 1, expiresAt: NOW + 2 * HOUR }))), 'issued in the future').toBeNull();
    expect(verify(envelope(A, payloadFor({ issuedAt: NOW + MAX_EMERGENCY_POLICY_CLOCK_AHEAD_MS, expiresAt: NOW + 2 * HOUR })))).not.toBeNull();
    expect(verify(envelope(A, payloadFor({ issuedAt: NOW, expiresAt: NOW + MAX_EMERGENCY_POLICY_LIFETIME_MS + 1 }))), 'lives too long').toBeNull();
    expect(verify(envelope(A, payloadFor({ issuedAt: NOW, expiresAt: NOW }))), 'no lifetime').toBeNull();
  });

  it('the shipped pins are frozen, well-formed public keys with distinct ids (never fetched, never a test key)', () => {
    expect(Object.isFrozen(EMERGENCY_POLICY_PINS)).toBe(true);
    for (const pin of EMERGENCY_POLICY_PINS) {
      expect(pin.kid).toMatch(/^ep1-[0-9a-f]{16}$/);
      expect(pin.ed25519).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.ed25519, 'the cross-implementation test vector is public; it must never be trusted').not.toBe('037e2b5619f0efd7d6edf60c4ad5c026660b1ef6880e68546b2c9f258d25cba6');
    }
    expect(new Set(EMERGENCY_POLICY_PINS.map((p) => p.kid)).size).toBe(EMERGENCY_POLICY_PINS.length);
  });

  it('a pin with notAfter is trusted only before that instant, and its policy is held no later than it; a pin without one is unaffected', () => {
    const END = NOW + HOUR;
    const S = testKey('ep1-5555555555555555');
    const expiring: EmergencyPolicyPin = { ...S.pin, notAfter: END };
    // Before notAfter: accepted, but trusted only until notAfter (not for the signed 24 h).
    expect(verify(envelope(S), 'GY', NOW, [expiring])?.expiresAt).toBe(END);
    expect(verify(envelope(S), 'GY', END - 1, [expiring])?.expiresAt).toBe(END);
    // At and after notAfter: refused, even an envelope the key holder dated to fit.
    expect(verify(envelope(S), 'GY', END, [expiring]), 'at notAfter').toBeNull();
    expect(verify(envelope(S, payloadFor({ issuedAt: END - 60_000, expiresAt: END + HOUR })), 'GY', END + 1, [expiring])).toBeNull();
    expect(verify(envelope(S, payloadFor({ issuedAt: END + HOUR, expiresAt: END + 2 * HOUR })), 'GY', END + HOUR, [expiring])).toBeNull();
    // A pin without notAfter (production), pinned beside the expired one, keeps its signed lifetime.
    const later = payloadFor({ issuedAt: END + HOUR, expiresAt: END + 2 * HOUR });
    expect(verify(envelope(A, later), 'GY', END + HOUR, [A.pin, expiring])?.expiresAt).toBe(END + 2 * HOUR);
    expect(verify(envelope(A), 'GY', NOW, [A.pin, expiring])?.expiresAt).toBe(NOW + 24 * HOUR);
    // A malformed notAfter fails closed.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, END + 0.5, '2026-12-15T05:00:00Z', null]) {
      expect(verify(envelope(S), 'GY', NOW, [{ ...S.pin, notAfter: bad as unknown as number }]), `notAfter ${String(bad)}`).toBeNull();
    }
  });

  it('ships exactly two pins (production + staging), each id derived from its own key, each a real curve point', () => {
    // A third pin is a key nobody reviewed; one fewer leaves that host's phones on the bundled numbers.
    expect(EMERGENCY_POLICY_PINS).toHaveLength(2);
    for (const pin of EMERGENCY_POLICY_PINS) {
      expect(Object.isFrozen(pin), pin.kid).toBe(true);
      // The API's derivation (apps/api emergency-policy-signature.ts): 'ep1-' + first 16 hex of SHA-256(raw key).
      // A one-character copy typo in either half of a pin fails here, not on a phone.
      const derived = `ep1-${createHash('sha256').update(Buffer.from(pin.ed25519, 'hex')).digest('hex').slice(0, 16)}`;
      expect(pin.kid, `${pin.kid} is derived from its key`).toBe(derived);
      const point = (() => { try { return ed25519.Point.fromHex(pin.ed25519); } catch { return null; } })();
      expect(point, `${pin.kid} decodes to a curve point`).not.toBeNull();
      expect(point?.isSmallOrder(), `${pin.kid} is not a small-order point`).toBe(false);
    }
    expect(new Set(EMERGENCY_POLICY_PINS.map((p) => p.ed25519)).size, 'two hosts never share a key').toBe(2);
    // The staging pin ends with the store-review demo; the production pin never expires.
    const byKid = new Map(EMERGENCY_POLICY_PINS.map((p) => [p.kid, p]));
    expect(byKid.get('ep1-5ebb7d4699ee0f78')?.notAfter, 'production has no expiry').toBeUndefined();
    expect(byKid.get('ep1-4a6de1b1e5c92f48')?.notAfter, 'staging stops at 2026-12-15T05:00:00Z').toBe(Date.parse('2026-12-15T05:00:00.000Z'));
    expect(EMERGENCY_POLICY_PINS.map((p) => p.kid), 'the cross-implementation vector is never pinned').not.toContain('ep1-4d4fac578075383c');
  });

  it('a pinned key id never makes another key trusted: only the pinned key itself verifies', () => {
    expect(EMERGENCY_POLICY_PINS.length).toBeGreaterThan(0);
    for (const pin of EMERGENCY_POLICY_PINS) {
      const impostor = testKey(pin.kid);
      expect(verify(envelope(impostor), 'GY', NOW, EMERGENCY_POLICY_PINS), `a test-drawn key claiming ${pin.kid}`).toBeNull();
    }
  });
});
