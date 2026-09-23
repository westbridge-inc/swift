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
// Whole-Caribbean availability (founder directive 2026-07-12): anyone signs up
// from any island and lands in THEIR market — the dial prefix decides the
// country (pricing, currency, checklists), never a client-picked field. The
// public /auth/pricing endpoint is the SaaS price-on-the-door partners see
// before committing.
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
    // Every vehicle is quoted at the rate of the role it provisions: delivery
    // riders 8,000, taxi drivers 9,000 (car or bus), heavy delivery 9,000.
    const rateFor = (v: string) => d.movers.find((q: { vehicleType: string }) => q.vehicleType === v)?.rate;
    expect([rateFor('MOTORCYCLE'), rateFor('CAR'), rateFor('BUS_15'), rateFor('CANTER_LONG')]).toEqual([8000, 9000, 9000, 9000]);
    expect(d.vendors).toEqual({
      service: 8000,
      catalogue: [
        { minItems: 0, tier: 'small', rate: 15000 },
        { minItems: 1000, tier: 'large', rate: 20000 },
        { minItems: 10000, tier: 'department', rate: 60000 },
      ],
    });
    // Older clients read the legacy numbers, which never under-quote a bill.
    expect(d.weekly.mover).toBe(9000);
    expect(d.weekly.moverHeavy).toBe(9000);
    expect(d.weekly.smallVendor).toBe(15000);
    expect(d.weekly.largeVendor).toBe(20000);
  });

  it('serves another island in its own currency', async () => {
    const res = await inject('GET', '/api/v1/auth/pricing?country=tt');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.countryCode).toBe('TT');
    expect(d.currencyCode).toBe('TTD');
    expect(d.weekly.mover).toBeGreaterThan(0);
  });

  it('404s an unknown market', async () => {
    const res = await inject('GET', '/api/v1/auth/pricing?country=ZZ');
    expect(res.statusCode).toBe(404);
  });
});

describe('signup lands in the phone country', () => {
  it('a Trinidad number registers as TT even if the client claims GY', async () => {
    const phone = `+1868555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const registrationProof = await registrationProofFor(app, phone);

    const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
      phone,
      registrationProof,
      firstName: 'Port',
      lastName: 'OfSpain',
      countryCode: 'GY', // spoof attempt — the dial prefix must win
    });
    expect(res.statusCode).toBe(201);
    const user = res.json().data.user;
    createdUserIds.push(user.id);
    expect(user.countryCode).toBe('TT');
  });

  it('a Guyana number stays GY', async () => {
    const phone = `+592655${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const registrationProof = await registrationProofFor(app, phone);
    const res = await inject('POST', '/api/v1/auth/register', { acceptTerms: true,
      phone,
      registrationProof,
      firstName: 'George',
      lastName: 'Town',
    });
    expect(res.statusCode).toBe(201);
    const user = res.json().data.user;
    createdUserIds.push(user.id);
    expect(user.countryCode).toBe('GY');
  });
});
