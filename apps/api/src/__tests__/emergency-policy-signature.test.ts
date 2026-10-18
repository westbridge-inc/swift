import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandler } from '../middleware/error-handler';
import { publicRoutes } from '../modules/public/public.routes';
import { serveEmergencyPolicy } from '../modules/country/emergency-policy';
import {
  EMERGENCY_ENVELOPE_TTL_MS, assertEmergencyPolicySigningConfig, canonicalEmergencyPayload, emergencyEnvelopeMessage,
  emergencyPolicySigner, emergencyPolicySignerFromSecret, signEmergencyEnvelope, type EmergencyEnvelope,
} from '../modules/country/emergency-policy-signature';
import { signingKeyId, type SigningKeyring } from '../utils/signing-keys';
import { SECRET_FILE_NAMES } from '../utils/secret-files';

// ---------------------------------------------------------------------------
// [AUD-G7-023 · MASTER-071 · board row 202] The emergency-number policy is
// signed with Ed25519 so the phone can CHECK it (the v1 HMAC can never be
// checked on a phone). Service-free: a stub CountryConfig reader, keys drawn
// fresh inside each test, never a real key, never a stored one.
// ---------------------------------------------------------------------------

const throwawaySecret = (): string => randomBytes(48).toString('base64');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEYRING: SigningKeyring = {
  current: { kid: signingKeyId('test-only-keyring-current-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), secret: 'test-only-keyring-current-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  previous: null,
};
const GY_STORED = {
  police: { number: '911', verified: true, verifiedAt: '2026-10-05T00:00:00.000Z', verifiedBy: 'owner-confirmation' },
  fire: { number: '912', verified: true, verifiedAt: '2026-10-05T00:00:00.000Z', verifiedBy: 'owner-confirmation' },
  ambulance: { number: '913', verified: true, verifiedAt: '2026-10-05T00:00:00.000Z', verifiedBy: 'owner-confirmation' },
  notes: 'ops-internal note',
};
const GY_POLICY = { country: 'GY', numbers: { police: GY_STORED.police, fire: GY_STORED.fire, ambulance: GY_STORED.ambulance } };

// The cross-implementation vector: the phone's verifier (apps/mobile/src/lib/
// emergencyPolicySignature.test.ts) accepts exactly these bytes. Ed25519 is
// deterministic, so the signature is fixed. The phrase is a public TEST VECTOR
// on purpose — no server holds it; real keys are random and generated on the
// host (deploy/owner/emergency-policy-key.command).
const CROSS_VECTOR_PHRASE = 'swift-emergency-policy-cross-vector-throwaway-0001';
const CROSS_VECTOR = {
  pin: { kid: 'ep1-4d4fac578075383c', ed25519: '037e2b5619f0efd7d6edf60c4ad5c026660b1ef6880e68546b2c9f258d25cba6' },
  envelope: {
    version: 2,
    alg: 'Ed25519',
    kid: 'ep1-4d4fac578075383c',
    payload: '{"country":"GY","expiresAt":1792238400000,"issuedAt":1792152000000,"numbers":{"ambulance":{"number":"913","verified":true},"fire":{"number":"912","verified":true},"police":{"number":"911","verified":true}},"v":2}',
    signature: 'cab80682f19a8a329ac2f05e739ad8a1b41590dd73b46d8a59cefeeaddb34785ce79c4bcdb177f76ac143092e489d0d55494be6591a030f253234dd87c885905',
  },
};

/** Verify exactly as a phone does: with the PUBLIC key only. */
function verifiesWith(publicKeyHex: string, envelope: EmergencyEnvelope): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
  return verify(null, emergencyEnvelopeMessage(envelope.kid, envelope.payload), key, Buffer.from(envelope.signature, 'hex'));
}

/** The v1 parser builds 9, 10 and 11 run (apps/mobile/src/lib/emergencyPolicy.ts parseServedPolicy at main 86324927), verbatim in behaviour. */
function buildElevenParse(raw: unknown, now: number): { country: string; numbers: Record<string, { number: string; verified: boolean }> } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1 || typeof r['country'] !== 'string' || !/^[A-Z]{2}$/.test(r['country'])) return null;
  if (typeof r['expiresAt'] !== 'string') return null;
  const expires = Date.parse(r['expiresAt']);
  if (!Number.isFinite(expires) || expires <= now) return null;
  const sig = r['signature'];
  if (!sig || typeof sig !== 'object' || typeof (sig as Record<string, unknown>)['kid'] !== 'string' || typeof (sig as Record<string, unknown>)['value'] !== 'string') return null;
  const nums = r['numbers'];
  if (!nums || typeof nums !== 'object' || Array.isArray(nums)) return null;
  const numbers: Record<string, { number: string; verified: boolean }> = {};
  for (const service of ['police', 'fire', 'ambulance']) {
    const entry = (nums as Record<string, unknown>)[service];
    if (entry === undefined || entry === null) continue;
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e['number'] !== 'string' || !/^\+?[0-9]{2,15}$/.test(e['number']) || typeof e['verified'] !== 'boolean') return null;
    numbers[service] = { number: e['number'], verified: e['verified'] };
  }
  if (Object.keys(numbers).length === 0) return null;
  return { country: r['country'], numbers };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[AUD-G7-023] the signing key is derived from a managed secret and never leaves its closure', () => {
  it('derives one Ed25519 key per secret, names it by its public half, and exposes no private material', () => {
    const secret = throwawaySecret();
    const a = emergencyPolicySignerFromSecret(secret);
    const b = emergencyPolicySignerFromSecret(secret);
    const other = emergencyPolicySignerFromSecret(throwawaySecret());
    expect(a.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.kid).toMatch(/^ep1-[0-9a-f]{16}$/);
    expect(b.publicKeyHex).toBe(a.publicKeyHex);
    expect(b.kid).toBe(a.kid);
    expect(other.publicKeyHex).not.toBe(a.publicKeyHex);
    expect(other.kid).not.toBe(a.kid);
    expect(Object.keys(a).sort()).toEqual(['kid', 'publicKeyHex', 'sign']);
    expect(Object.isFrozen(a)).toBe(true);
    expect(JSON.stringify(a)).not.toContain(secret);
  });

  it('production refuses to start without the key or with a short one; a short one is refused everywhere; no message carries a value', () => {
    expect(() => assertEmergencyPolicySigningConfig({ NODE_ENV: 'production' })).toThrow(/FATAL: EMERGENCY_POLICY_SIGNING_KEY is required in production/);
    expect(() => assertEmergencyPolicySigningConfig({ NODE_ENV: 'production', EMERGENCY_POLICY_SIGNING_KEY: '' })).toThrow(/required in production/);
    const short = 'short-but-secret-value-123';
    for (const mode of ['production', 'development', 'test', 'loadtest']) {
      let message = '';
      try {
        emergencyPolicySigner({ NODE_ENV: mode, EMERGENCY_POLICY_SIGNING_KEY: short });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, mode).toMatch(/at least 32 characters/);
      expect(message, mode).not.toContain(short);
    }
    expect(emergencyPolicySigner({ NODE_ENV: 'development' })).toBeNull();
    expect(emergencyPolicySigner({ NODE_ENV: 'test' })).toBeNull();
    const secret = throwawaySecret();
    const signer = assertEmergencyPolicySigningConfig({ NODE_ENV: 'production', EMERGENCY_POLICY_SIGNING_KEY: secret });
    expect(signer?.publicKeyHex).toBe(emergencyPolicySignerFromSecret(secret).publicKeyHex);
  });

  it('arrives like every other secret: allowlisted for *_FILE delivery, wired to the api alone, and checked at boot before the app is built', () => {
    expect(SECRET_FILE_NAMES).toContain('EMERGENCY_POLICY_SIGNING_KEY');
    const compose = readFileSync(join(__dirname, '..', '..', '..', '..', 'deploy', 'docker-compose.yml'), 'utf8');
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
    const afterWorker = compose.slice(compose.indexOf('\n  worker:') + 1);
    const nextService = afterWorker.search(/\n {2}[a-z][\w-]*:\s*\n/);
    const worker = nextService > 0 ? afterWorker.slice(0, nextService) : afterWorker;
    expect(api).toContain('EMERGENCY_POLICY_SIGNING_KEY_FILE: /run/secrets/EMERGENCY_POLICY_SIGNING_KEY');
    expect(worker.length).toBeGreaterThan(100);
    expect(worker, 'the worker never signs, so it never holds the key').not.toContain('EMERGENCY_POLICY_SIGNING_KEY');
    const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const guard = server.indexOf('assertEmergencyPolicySigningConfig()');
    expect(guard).toBeGreaterThan(server.indexOf('assertSafeBootConfig();'));
    expect(guard).toBeLessThan(server.indexOf('await buildApp()'));
  });
});

describe('[AUD-G7-023] the envelope binds the numbers, the market, the time and the key', () => {
  it('signs canonical ASCII of only number + verified, verifiable with the public key alone', () => {
    const signer = emergencyPolicySignerFromSecret(throwawaySecret());
    const now = new Date('2026-10-16T12:00:00.000Z');
    const envelope = signEmergencyEnvelope(GY_POLICY, signer, now);
    expect(envelope).toMatchObject({ version: 2, alg: 'Ed25519', kid: signer.kid });
    expect(envelope.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(envelope.payload).toBe(
      `{"country":"GY","expiresAt":${now.getTime() + EMERGENCY_ENVELOPE_TTL_MS},"issuedAt":${now.getTime()},` +
      '"numbers":{"ambulance":{"number":"913","verified":true},"fire":{"number":"912","verified":true},"police":{"number":"911","verified":true}},"v":2}',
    );
    expect(envelope.payload).not.toMatch(/verifiedBy|verifiedAt|notes|owner-confirmation/);
    expect(verifiesWith(signer.publicKeyHex, envelope)).toBe(true);
  });

  it('a changed number, a flipped verified flag, another market, another key id or another key does not verify', () => {
    const signer = emergencyPolicySignerFromSecret(throwawaySecret());
    const envelope = signEmergencyEnvelope(GY_POLICY, signer, new Date('2026-10-16T12:00:00.000Z'));
    const tampered = (payload: string): EmergencyEnvelope => ({ ...envelope, payload });
    expect(verifiesWith(signer.publicKeyHex, tampered(envelope.payload.replace('"number":"911"', '"number":"999"')))).toBe(false);
    expect(verifiesWith(signer.publicKeyHex, tampered(envelope.payload.replace('"number":"912","verified":true', '"number":"912","verified":false')))).toBe(false);
    expect(verifiesWith(signer.publicKeyHex, tampered(envelope.payload.replace('"country":"GY"', '"country":"TT"')))).toBe(false);
    expect(verifiesWith(signer.publicKeyHex, { ...envelope, kid: 'ep1-0000000000000000' })).toBe(false);
    expect(verifiesWith(emergencyPolicySignerFromSecret(throwawaySecret()).publicKeyHex, envelope)).toBe(false);
  });

  it('emits byte-for-byte the vector the phone verifies (the two implementations agree)', () => {
    const signer = emergencyPolicySignerFromSecret(CROSS_VECTOR_PHRASE);
    expect({ kid: signer.kid, ed25519: signer.publicKeyHex }).toEqual(CROSS_VECTOR.pin);
    expect(signEmergencyEnvelope(GY_POLICY, signer, new Date('2026-10-16T12:00:00.000Z'))).toEqual(CROSS_VECTOR.envelope);
    expect(verifiesWith(CROSS_VECTOR.pin.ed25519, CROSS_VECTOR.envelope as EmergencyEnvelope)).toBe(true);
  });

  it('the canonical payload is independent of stored key order and refuses non-ASCII', () => {
    const reordered = { ambulance: GY_STORED.ambulance, police: GY_STORED.police, fire: GY_STORED.fire };
    const base = { country: 'GY', issuedAt: 1, expiresAt: 2 };
    expect(canonicalEmergencyPayload({ ...base, numbers: reordered })).toBe(canonicalEmergencyPayload({ ...base, numbers: GY_POLICY.numbers }));
    expect(() => canonicalEmergencyPayload({ ...base, country: 'GÜ', numbers: GY_POLICY.numbers })).toThrow(/ASCII/);
    expect(() => emergencyEnvelopeMessage('Bad Kid', '{}')).toThrow(/key id/);
  });
});

describe('[AUD-G7-023] GET /public/emergency-policy carries the envelope beside the unchanged v1 body', () => {
  let app: FastifyInstance | null = null;
  const stored: Record<string, unknown> = { GY: GY_STORED, ZQ: null };
  const stubPrisma = {
    countryConfig: {
      findUnique: async ({ where }: { where: { code: string } }) => (where.code in stored ? { code: where.code, emergency: stored[where.code] } : null),
    },
  };
  async function build(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    registerErrorHandler(instance);
    instance.decorate('prisma', stubPrisma as never);
    await instance.register(publicRoutes, { prefix: '/api/v1/public' });
    await instance.ready();
    return instance;
  }
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('serves a verifiable Ed25519 envelope for the market asked for, and builds 9-11 still read the v1 body exactly as before', async () => {
    const secret = throwawaySecret();
    vi.stubEnv('EMERGENCY_POLICY_SIGNING_KEY', secret);
    const signer = emergencyPolicySignerFromSecret(secret);
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=gy' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown> & { envelope: EmergencyEnvelope };
    expect(data.envelope).toMatchObject({ version: 2, alg: 'Ed25519', kid: signer.kid });
    expect(verifiesWith(signer.publicKeyHex, data.envelope)).toBe(true);
    expect(JSON.parse(data.envelope.payload)).toMatchObject({ country: 'GY', numbers: { police: { number: '911', verified: true } } });
    expect(res.body).not.toContain(secret);
    // The v1 body is exactly what the HMAC signer produces, so nothing changes for builds 9-11.
    const v1 = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'envelope'));
    expect(Object.keys(v1).sort()).toEqual(['country', 'expiresAt', 'issuedAt', 'numbers', 'signature', 'version']);
    expect(v1).toMatchObject({ version: 1, country: 'GY', signature: { alg: 'HMAC-SHA256' } });
    expect(buildElevenParse(data, Date.now())).toEqual({
      country: 'GY',
      numbers: { police: { number: '911', verified: true }, fire: { number: '912', verified: true }, ambulance: { number: '913', verified: true } },
    });
  });

  it('without a key outside production the v1 body is served alone; a broken key never fails the emergency route', async () => {
    app = await build();
    const plain = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=GY' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().data.envelope).toBeUndefined();
    expect(buildElevenParse(plain.json().data, Date.now())?.numbers['police']).toEqual({ number: '911', verified: true });
    vi.stubEnv('EMERGENCY_POLICY_SIGNING_KEY', 'too-short');
    const broken = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=GY' });
    expect(broken.statusCode).toBe(200);
    expect(broken.json().data.envelope).toBeUndefined();
    expect(broken.json().data.version).toBe(1);
    // No policy: nothing to sign, nothing signed.
    vi.stubEnv('EMERGENCY_POLICY_SIGNING_KEY', throwawaySecret());
    const none = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=ZQ' });
    expect(none.json().data).toEqual({ version: 1, country: 'ZQ', numbers: null, reason: 'NO_POLICY' });
  });

  it('serveEmergencyPolicy reports a signing failure instead of throwing it', async () => {
    const served = await serveEmergencyPolicy(stubPrisma as never, 'GY', KEYRING, new Date(), () => {
      throw new Error('FATAL: synthetic signer failure');
    });
    expect(served).toMatchObject({ status: 'served', envelope: null, envelopeProblem: 'FATAL: synthetic signer failure' });
  });
});
