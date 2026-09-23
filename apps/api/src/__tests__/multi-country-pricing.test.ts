import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { authRoutes } from '../modules/auth/auth.routes';
import { registrationProofFor } from './helpers/otp';
import { registerErrorHandler } from '../middleware/error-handler';
import { countryFromPhone } from '../utils/phone-country';
import { TRIAL_DAYS } from '../modules/subscription/subscription.service';

// ---------------------------------------------------------------------------
// Guyana-only V1 public launch. Future-market currency and phone metadata stay
// intact for a reviewed expansion, but public signup and price-on-the-door
// routes must not expose those markets before they are launched. OTP remains
// market-neutral because the same endpoint authenticates existing accounts
// and powers password recovery without revealing whether an account exists.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];

function inject(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('countryFromPhone', () => {
  it('maps every Caribbean footprint prefix', () => {
    expect(countryFromPhone('+5926001234')).toBe('GY');
    expect(countryFromPhone('+5978123456')).toBe('SR');
    expect(countryFromPhone('+5016123456')).toBe('BZ');
    expect(countryFromPhone('+18685550123')).toBe('TT');
    expect(countryFromPhone('+12465550123')).toBe('BB');
    expect(countryFromPhone('+18765550123')).toBe('JM');
    expect(countryFromPhone('+16585550123')).toBe('JM');
    expect(countryFromPhone('+17585550123')).toBe('LC');
    expect(countryFromPhone('+17845550123')).toBe('VC');
    expect(countryFromPhone('+14735550123')).toBe('GD');
    expect(countryFromPhone('+17675550123')).toBe('DM');
    expect(countryFromPhone('+18695550123')).toBe('KN');
    expect(countryFromPhone('+12685550123')).toBe('AG');
    expect(countryFromPhone('+12425550123')).toBe('BS');
  });

  it('returns null for prefixes outside the footprint', () => {
    expect(countryFromPhone('+15550001111')).toBeNull(); // NANP but not ours
    expect(countryFromPhone('+447700900000')).toBeNull();
  });
});

describe('public pricing (price on the door)', () => {
  it('serves the weekly tiers + trial length for the default market', async () => {
    const res = await inject('GET', '/api/v1/auth/pricing');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.countryCode).toBe('GY');
    expect(d.trialDays).toBe(TRIAL_DAYS);
    // Two mover bands: standard (bike/motorbike/car/wagon) and heavy
    // (bus/canter/box truck). The public endpoint quotes both.
    expect(d.weekly.mover).toBe(10000);
    expect(d.weekly.moverHeavy).toBe(12000);
    expect(d.weekly.smallVendor).toBe(20000);
    expect(d.weekly.largeVendor).toBe(30000);
  });

  it('does not publish a future island price book', async () => {
    const res = await inject('GET', '/api/v1/auth/pricing?country=tt');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('COUNTRY_NOT_FOUND');
  });

  it('404s an unknown market', async () => {
    const res = await inject('GET', '/api/v1/auth/pricing?country=ZZ');
    expect(res.statusCode).toBe(404);
  });
});

describe('public auth stays inside the launch market', () => {
  it('rejects a new Trinidad account after phone ownership is proven', async () => {
    const phone = `+1868555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const registrationProof = await registrationProofFor(app, phone);
    const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
      phone,
      registrationProof,
      firstName: 'Port',
      lastName: 'OfSpain',
      countryCode: 'GY',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('COUNTRY_NOT_ACTIVE');
  });

  it('a Guyana number stays GY even if the client claims a future market', async () => {
    const phone = `+592655${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const registrationProof = await registrationProofFor(app, phone);
    const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
      phone,
      registrationProof,
      firstName: 'George',
      lastName: 'Town',
      countryCode: 'TT',
    });
    expect(res.statusCode).toBe(201);
    const user = res.json().data.user;
    createdUserIds.push(user.id);
    expect(user.countryCode).toBe('GY');
  });
});
