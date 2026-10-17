import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [AUD-G7-023 · board row 202] Who the SOS button calls, end to end on the
// phone: the served policy → the signature check → the process cache → the
// synchronous press-time decision. Anything that can alter the response must
// not change the number; a bad or missing signature keeps the last policy that
// verified, or the bundled numbers (Guyana 911 / 912 / 913) — never none.
// The pinned key here is a throwaway drawn inside this file.
// ---------------------------------------------------------------------------

const get = vi.fn();
vi.mock('./api', () => ({ api: { get: (...args: unknown[]) => get(...args) } }));
vi.mock('../stores/authStore', () => {
  const state = { countryCode: 'GY' };
  return { useAuthStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock('../lib/emergencyPolicyPins', async () => {
  const { ed25519 } = await import('@noble/curves/ed25519');
  const secret = ed25519.utils.randomPrivateKey();
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return {
    EMERGENCY_POLICY_PINS: Object.freeze([{ kid: 'ep1-5555555555555555', ed25519: hex(ed25519.getPublicKey(secret)) }]),
    TEST_ONLY_SIGNING_SECRET: secret,
  };
});

import { ed25519 } from '@noble/curves/ed25519';
import * as pinned from '../lib/emergencyPolicyPins';
import { emergencyDialFor, fetchEmergencyPolicy, resetEmergencyPolicyForTests } from './emergencyPolicy';

const PINNED_SECRET = (pinned as unknown as { TEST_ONLY_SIGNING_SECRET: Uint8Array }).TEST_ONLY_SIGNING_SECRET;
const PINNED_KID = 'ep1-5555555555555555';
const UNPINNED_SECRET = ed25519.utils.randomPrivateKey();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function payload(o: { country?: string; police?: string; policeVerified?: boolean; issuedAt?: number; expiresAt?: number } = {}): string {
  const issuedAt = o.issuedAt ?? Date.now();
  return `{"country":"${o.country ?? 'GY'}","expiresAt":${o.expiresAt ?? issuedAt + 3_600_000},"issuedAt":${issuedAt},` +
    `"numbers":{"ambulance":{"number":"913","verified":true},"fire":{"number":"912","verified":true},"police":{"number":"${o.police ?? '911'}","verified":${o.policeVerified ?? true}}},"v":2}`;
}
function envelope(text: string, secret = PINNED_SECRET, kid = PINNED_KID): Record<string, unknown> {
  const message = new TextEncoder().encode(`swift.emergency-policy.v2\u0000Ed25519\u0000${kid}\u0000${text}`);
  return { version: 2, alg: 'Ed25519', kid, payload: text, signature: hex(ed25519.sign(message, secret)) };
}
/** The API's answer: the v1 body (shape-only "signature") with, optionally, the Ed25519 envelope beside it. */
function answer(o: { v1Police?: string; envelope?: Record<string, unknown> } = {}): { data: { success: true; data: Record<string, unknown> } } {
  const now = Date.now();
  return {
    data: {
      success: true,
      data: {
        version: 1,
        country: 'GY',
        numbers: { police: { number: o.v1Police ?? '911', verified: true }, fire: { number: '912', verified: true }, ambulance: { number: '913', verified: true } },
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        signature: { alg: 'HMAC-SHA256', kid: 'abcd1234', value: 'f'.repeat(64) },
        ...(o.envelope ? { envelope: o.envelope } : {}),
      },
    },
  };
}

beforeEach(() => {
  resetEmergencyPolicyForTests();
  get.mockReset();
});

describe('[AUD-G7-023] a tampered emergency policy cannot change who SOS calls', () => {
  it('a forged policy without a valid signature is refused; SOS dials the bundled 911, 912, 913', async () => {
    get.mockResolvedValueOnce(answer({ v1Police: '5550100' }));
    expect(await fetchEmergencyPolicy('GY')).toBeNull();
    expect(emergencyDialFor('GY')).toEqual({ kind: 'auto', country: 'GY', number: '911', service: 'police', source: 'bundled' });
    expect(emergencyDialFor('GY', 'fire')).toMatchObject({ kind: 'auto', number: '912', source: 'bundled' });
    expect(emergencyDialFor('GY', 'ambulance')).toMatchObject({ kind: 'auto', number: '913', source: 'bundled' });
  });

  it('a validly signed policy from a pinned key is used; later tampered, unsigned or foreign-key answers keep it', async () => {
    get.mockResolvedValueOnce(answer({ envelope: envelope(payload({ police: '911' })) }));
    expect((await fetchEmergencyPolicy('GY'))?.source).toBe('server');
    expect(emergencyDialFor('GY')).toEqual({ kind: 'auto', country: 'GY', number: '911', service: 'police', source: 'server' });

    const signedOther = envelope(payload({ police: '911' }));
    const attacks: Array<[string, ReturnType<typeof answer>]> = [
      ['signed numbers edited after signing', answer({ envelope: { ...signedOther, payload: (signedOther['payload'] as string).replace('"number":"911"', '"number":"5550100"') } })],
      ['v1 numbers edited, envelope stripped', answer({ v1Police: '5550100' })],
      ['signed by a key the app does not pin', answer({ envelope: envelope(payload({ police: '5550100' }), UNPINNED_SECRET) })],
      ['a verified flag flipped after signing', answer({ envelope: { ...signedOther, payload: (signedOther['payload'] as string).replace('"number":"912","verified":true', '"number":"912","verified":false') } })],
    ];
    for (const [label, response] of attacks) {
      get.mockResolvedValueOnce(response);
      expect(await fetchEmergencyPolicy('GY'), label).toBeNull();
      expect(emergencyDialFor('GY'), label).toEqual({ kind: 'auto', country: 'GY', number: '911', service: 'police', source: 'server' });
    }
    get.mockRejectedValueOnce(new Error('offline'));
    expect(await fetchEmergencyPolicy('GY')).toBeNull();
    expect(emergencyDialFor('GY')).toMatchObject({ number: '911', source: 'server' });
  });

  it('a signed policy for another market is not accepted for this one', async () => {
    get.mockResolvedValueOnce(answer({ envelope: envelope(payload({ country: 'TT', police: '999' })) }));
    expect(await fetchEmergencyPolicy('GY')).toBeNull();
    expect(emergencyDialFor('GY')).toMatchObject({ kind: 'auto', number: '911', source: 'bundled' });
  });

  it('an older signed policy never replaces a newer one (a replayed answer)', async () => {
    const now = Date.now();
    get.mockResolvedValueOnce(answer({ envelope: envelope(payload({ police: '911', issuedAt: now })) }));
    await fetchEmergencyPolicy('GY');
    get.mockResolvedValueOnce(answer({ envelope: envelope(payload({ police: '999', issuedAt: now - 60_000 })) }));
    await fetchEmergencyPolicy('GY');
    expect(emergencyDialFor('GY')).toMatchObject({ number: '911', source: 'server' });
  });

  it('when the last verified policy expires, SOS falls back to the bundled numbers — never to nothing', async () => {
    const now = Date.now();
    get.mockResolvedValueOnce(answer({ envelope: envelope(payload({ police: '911', policeVerified: false, issuedAt: now - 3_590_000, expiresAt: now + 10_000 })) }));
    await fetchEmergencyPolicy('GY');
    expect(emergencyDialFor('GY')).toMatchObject({ kind: 'confirm', number: '911', source: 'server' });
    vi.useFakeTimers({ now: now + 20_000 });
    try {
      expect(emergencyDialFor('GY')).toEqual({ kind: 'auto', country: 'GY', number: '911', service: 'police', source: 'bundled' });
    } finally {
      vi.useRealTimers();
    }
  });
});
