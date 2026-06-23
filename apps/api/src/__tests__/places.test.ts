import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { placesRoutes } from '../modules/places/places.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LocalPlacesProvider } from '../providers/places/places-provider';

// ---------------------------------------------------------------------------
// Places — the "Where to?" search behind the PlacesProvider seam. Exercises the
// default (key-free) LocalPlacesProvider against seeded zones + a saved address,
// plus the route's auth + Zod guards (failure paths first). The Google key path
// is config-only and never touches the server response here.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
let token: string;

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200201' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

function inject(url: string, tok?: string) {
  return app.inject({ method: 'GET', url, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
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
  await app.register(placesRoutes, { prefix: '/api/v1/places' });
  await app.ready();

  await purgeFixtures();

  const user = await app.prisma.user.create({
    data: {
      phone: '+59200201',
      firstName: 'Places',
      lastName: 'Tester',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'places', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  await app.prisma.address.create({
    data: {
      userId: user.id,
      label: 'Mum’s House',
      addressLine1: '12 Sheriff Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.805,
      longitude: -58.15,
    },
  });
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('GET /places/autocomplete — guards', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await inject('/api/v1/places/autocomplete?q=george');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing query (Zod)', async () => {
    const res = await inject('/api/v1/places/autocomplete', token);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a blank query (Zod min length)', async () => {
    const res = await inject('/api/v1/places/autocomplete?q=%20%20', token);
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /places/autocomplete — local provider', () => {
  it('returns matching active zones as suggestions', async () => {
    const res = await inject('/api/v1/places/autocomplete?q=georgetown', token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ placeId: string; primary: string }>;
    const zoneIds = data.filter((s) => s.placeId.startsWith('zone:')).map((s) => s.placeId);
    expect(zoneIds).toContain('zone:georgetown-central');
  });

  it("folds in the caller's own saved addresses", async () => {
    const res = await inject('/api/v1/places/autocomplete?q=sheriff', token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ placeId: string; primary: string }>;
    expect(data.some((s) => s.placeId.startsWith('addr:') && /Mum/.test(s.primary))).toBe(true);
  });
});

describe('GET /places/details — resolves to a coordinate', () => {
  it('resolves a zone suggestion to its centroid', async () => {
    const res = await inject('/api/v1/places/details?placeId=zone:georgetown-central', token);
    expect(res.statusCode).toBe(200);
    const d = res.json().data as { lat: number; lng: number; label: string } | null;
    expect(d).not.toBeNull();
    // Georgetown Central ring centroid sits inside its 6.78–6.83 / -58.18–-58.13 box.
    expect(d!.lat).toBeGreaterThan(6.78);
    expect(d!.lat).toBeLessThan(6.83);
    expect(d!.lng).toBeGreaterThan(-58.18);
    expect(d!.lng).toBeLessThan(-58.13);
  });

  it('returns null for an unknown placeId', async () => {
    const res = await inject('/api/v1/places/details?placeId=zone:does-not-exist', token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeNull();
  });
});

describe('LocalPlacesProvider — reverse geocode', () => {
  it('labels a point with its nearest active zone', async () => {
    const provider = new LocalPlacesProvider(app.prisma);
    const label = await provider.reverseGeocode({ lat: 6.81, lng: -58.155 });
    expect(label).toBe('Georgetown Central');
  });
});
