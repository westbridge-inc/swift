import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { registerErrorHandler } from '../middleware/error-handler';
import { publicRoutes } from '../modules/public/public.routes';
import {
  canonicalPolicyPayload, parseEmergencyPolicy, serveEmergencyPolicy, signEmergencyPolicy, verifyEmergencyPolicy, type SignedEmergencyPolicy,
} from '../modules/country/emergency-policy';
import { signingKeyId, type SigningKeyring } from '../utils/signing-keys';

// ---------------------------------------------------------------------------
// [MOB-018] The market emergency policy: a market fact ops verifies, served
// signed and cacheable, never served when malformed, honest when absent.
// ---------------------------------------------------------------------------

const KEYRING: SigningKeyring = {
  current: { kid: signingKeyId('test-only-keyring-current-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), secret: 'test-only-keyring-current-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  previous: { kid: signingKeyId('test-only-keyring-previous-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), secret: 'test-only-keyring-previous-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
};
const GY_POLICY = {
  police: { number: '911', verified: true, verifiedAt: '2026-09-02T00:00:00.000Z', verifiedBy: 'launch-market' },
  fire: { number: '912', verified: false },
  ambulance: { number: '913', verified: false },
};

let app: FastifyInstance;
let priorGy: unknown = undefined;
const TEST_MARKET = 'ZQ';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
  const gy = await app.prisma.countryConfig.findUnique({ where: { code: 'GY' }, select: { emergency: true } });
  priorGy = gy?.emergency;
  await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { emergency: GY_POLICY } });
  await app.prisma.countryConfig.upsert({
    where: { code: TEST_MARKET },
    update: { emergency: null as never },
    create: { code: TEST_MARKET, name: 'Test Market', currencyCode: 'TST', currencySymbol: 'T$', usdExchangeRate: 1, subscriptionTiers: {}, documentChecklists: {}, isActive: false },
  });
});
afterAll(async () => {
  await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { emergency: (priorGy ?? null) as never } }).catch(() => {});
  await app.prisma.countryConfig.deleteMany({ where: { code: TEST_MARKET } }).catch(() => {});
  await app.close();
});

describe('[MOB-018] the stored policy is validated before it is ever served', () => {
  it('accepts a well-formed policy and refuses every malformed one with a named problem', () => {
    expect(parseEmergencyPolicy('GY', GY_POLICY).policy).toMatchObject({ country: 'GY', numbers: { police: { number: '911', verified: true }, fire: { number: '912', verified: false } } });
    expect(parseEmergencyPolicy('GY', null)).toEqual({ policy: null });
    expect(parseEmergencyPolicy('GY', undefined)).toEqual({ policy: null });
    const bad: Array<[unknown, RegExp]> = [
      ['911', /not an object/],
      [[], /not an object/],
      [{}, /names no service/],
      [{ police: '911' }, /police is not an object/],
      [{ police: { number: '9-1-1', verified: true, verifiedAt: '2026-09-02' } }, /not a dialable number/],
      [{ police: { number: '911', verified: 'yes' } }, /verified is not a boolean/],
      [{ police: { number: '911', verified: true } }, /verified without a verification date/],
      [{ police: { number: '911', verified: true, verifiedAt: 'yesterday' } }, /verified without a verification date/],
    ];
    for (const [raw, problem] of bad) {
      const r = parseEmergencyPolicy('GY', raw);
      expect(r.policy, JSON.stringify(raw)).toBeNull();
      expect(r.problem, JSON.stringify(raw)).toMatch(problem);
    }
  });
});

describe('[MOB-018] the signature binds the bytes, the key and the time', () => {
  it('signs with the current key, verifies with current or previous, and refuses a foreign key, a tampered number, or an expired policy', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    const signed = signEmergencyPolicy({ country: 'GY', numbers: GY_POLICY }, KEYRING, now);
    expect(signed.signature.kid).toBe(KEYRING.current.kid);
    expect(verifyEmergencyPolicy(signed, KEYRING, now)).toBe(true);
    // a rotation: the previous key still verifies what it signed
    const rotated: SigningKeyring = { current: { kid: signingKeyId('test-only-keyring-rotated-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), secret: 'test-only-keyring-rotated-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, previous: KEYRING.current };
    expect(verifyEmergencyPolicy(signed, rotated, now)).toBe(true);
    // a key nobody holds
    expect(verifyEmergencyPolicy(signed, { current: rotated.current, previous: null }, now)).toBe(false);
    // a tampered number
    const tampered: SignedEmergencyPolicy = { ...signed, numbers: { ...signed.numbers, police: { number: '112', verified: true } } };
    expect(verifyEmergencyPolicy(tampered, KEYRING, now)).toBe(false);
    // expired
    expect(verifyEmergencyPolicy(signed, KEYRING, new Date(Date.parse(signed.expiresAt) + 1))).toBe(false);
    // the canonical payload is key-order independent
    const unsigned = Object.fromEntries(Object.entries(signed).filter(([k]) => k !== 'signature')) as Omit<SignedEmergencyPolicy, 'signature'>;
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(unsigned).reverse()))) as typeof unsigned;
    expect(canonicalPolicyPayload(reordered)).toBe(canonicalPolicyPayload(unsigned));
  });
});

describe('[MOB-018] GET /public/emergency-policy', () => {
  it('serves the launch market signed and cacheable, with only the verified number marked verified', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=gy' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=3600');
    const data = res.json().data as SignedEmergencyPolicy;
    expect(data).toMatchObject({ version: 1, country: 'GY', numbers: { police: { number: '911', verified: true }, fire: { number: '912', verified: false }, ambulance: { number: '913', verified: false } } });
    expect(data.signature).toMatchObject({ alg: 'HMAC-SHA256' });
    expect(typeof data.signature.kid).toBe('string');
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('a market with no policy answers numbers: null and says so; an unknown market is 404; a malformed stored policy is never served', async () => {
    const none = await app.inject({ method: 'GET', url: `/api/v1/public/emergency-policy?country=${TEST_MARKET}` });
    expect(none.statusCode).toBe(200);
    expect(none.json().data).toEqual({ version: 1, country: TEST_MARKET, numbers: null, reason: 'NO_POLICY' });
    const unknown = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=XX' });
    expect(unknown.statusCode).toBe(404);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/public/emergency-policy?country=G' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    await app.prisma.countryConfig.update({ where: { code: TEST_MARKET }, data: { emergency: { police: { number: 'nine-one-one', verified: true } } } });
    try {
      const invalid = await app.inject({ method: 'GET', url: `/api/v1/public/emergency-policy?country=${TEST_MARKET}` });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json().data).toEqual({ version: 1, country: TEST_MARKET, numbers: null, reason: 'INVALID_POLICY' });
      const served = await serveEmergencyPolicy(app.prisma, TEST_MARKET, KEYRING);
      expect(served).toMatchObject({ status: 'invalid', problem: expect.stringContaining('not a dialable number') });
    } finally {
      await app.prisma.countryConfig.update({ where: { code: TEST_MARKET }, data: { emergency: null as never } });
    }
  });
});
