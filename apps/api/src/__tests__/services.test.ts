import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Services (spec §4.6). Provider profile + qualification badge +
// "self-skilled" transparency; risk-tiered browse; the job lifecycle
// (request -> quote -> schedule -> complete) with two-way ratings; and the
// ID + police-clearance gate before a provider can take jobs.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200188${String(seq).padStart(2, '0')}`,
      firstName: 'Svc', lastName: `User${seq}`, roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'step21', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function approveProviderDocs(userId: string) {
  for (const docType of ['national_id', 'police_clearance']) {
    await app.prisma.verificationDocument.create({
      data: { userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    });
  }
}

/** A verified provider with a profile. */
async function makeVerifiedProvider(trade: string) {
  const u = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  await approveProviderDocs(u.userId);
  const res = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  const provider = res.json().data;
  return { ...u, providerId: provider.id, isVerified: provider.isVerified };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200188' } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  createdUserIds.length = 0;
  if (userIds.length === 0) return;
  const jobs = await app.prisma.serviceJob.findMany({
    where: { OR: [{ customerId: { in: userIds } }, { provider: { userId: { in: userIds } } }] },
    select: { id: true },
  });
  const jobIds = jobs.map((j) => j.id);
  await app.prisma.rating.deleteMany({ where: { OR: [{ raterId: { in: userIds } }, { orderId: { in: jobIds } }] } });
  await app.prisma.chatRoom.deleteMany({ where: { serviceJobId: { in: jobIds } } });
  await app.prisma.serviceJob.deleteMany({ where: { id: { in: jobIds } } });
  await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
  await app.register(socketPlugin);
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Services — provider verification + qualification badge', () => {
  it('is unverified without police clearance; verified with it', async () => {
    const u = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    // Only national_id approved — police clearance missing.
    await app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType: 'national_id', fileUrl: 'storage://t/id.jpg', status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    });
    let res = await inject('POST', '/api/v1/services/providers', { trade: 'plumber' }, u.token);
    expect(res.json().data.isVerified).toBe(false);
    expect(res.json().data.selfSkilled).toBe(true);

    // Add police clearance → verified on next upsert.
    await app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType: 'police_clearance', fileUrl: 'storage://t/pc.jpg', status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    });
    res = await inject('POST', '/api/v1/services/providers', { trade: 'plumber' }, u.token);
    expect(res.json().data.isVerified).toBe(true);
  });

  it('a verified GEI licence earns the Certified badge and drops self-skilled', async () => {
    const p = await makeVerifiedProvider('electrician');
    const qual = await inject('POST', '/api/v1/services/providers/qualifications', { type: 'GEI_LICENCE', referenceNumber: 'GEI-44821' }, p.token);
    expect(qual.statusCode).toBe(200);
    expect(qual.json().data.status).toBe('VERIFIED');

    const me = await inject('GET', '/api/v1/services/providers/me', undefined, p.token);
    expect(me.json().data.certified).toBe(true);
    expect(me.json().data.selfSkilled).toBe(false);
  });
});

describe('Services — risk-tiered browse', () => {
  it('marks high-risk trades and recommends a licensed provider', async () => {
    const p = await makeVerifiedProvider('electrician');
    await inject('POST', '/api/v1/services/providers/qualifications', { type: 'GEI_LICENCE', referenceNumber: 'GEI-90011' }, p.token);

    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('GET', '/api/v1/services/providers?trade=electrician', undefined, customer.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.riskTier).toBe('HIGH');
    expect(res.json().data.guidance).toMatch(/licensed|certified/i);
    expect(res.json().data.providers.length).toBeGreaterThanOrEqual(1);
    expect(res.json().data.providers[0].certified).toBe(true); // licensed listed first
  });
});

describe('Services — job lifecycle + two-way rating', () => {
  it('runs request → quote → schedule → complete → both parties rate', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');

    const created = await inject('POST', '/api/v1/services/jobs', {
      providerId: provider.providerId,
      description: 'Build a set of kitchen shelves, photos attached.',
    }, customer.token);
    expect(created.statusCode).toBe(201);
    const jobId = created.json().data.id;
    expect(created.json().data.status).toBe('REQUESTED');
    expect(created.json().data.chatRoomId).toBeTruthy(); // quote-via-chat room opened

    const quoted = await inject('POST', `/api/v1/services/jobs/${jobId}/quote`, { amount: 15000 }, provider.token);
    expect(quoted.json().data.status).toBe('QUOTED');
    expect(Number(quoted.json().data.quoteAmount)).toBe(15000);

    const scheduled = await inject('POST', `/api/v1/services/jobs/${jobId}/schedule`, { scheduledFor: new Date(Date.now() + 2 * DAY).toISOString() }, customer.token);
    expect(scheduled.json().data.status).toBe('SCHEDULED');

    const completed = await inject('POST', `/api/v1/services/jobs/${jobId}/complete`, {}, provider.token);
    expect(completed.json().data.status).toBe('COMPLETED');

    // Two-way ratings.
    const custRates = await inject('POST', `/api/v1/services/jobs/${jobId}/rate`, { score: 5, comment: 'Excellent work' }, customer.token);
    expect(custRates.json().data.type).toBe('CUSTOMER_TO_PROVIDER');
    const provRates = await inject('POST', `/api/v1/services/jobs/${jobId}/rate`, { score: 5 }, provider.token);
    expect(provRates.json().data.type).toBe('PROVIDER_TO_CUSTOMER');

    const updated = await app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: provider.providerId } });
    expect(updated.totalRatings).toBe(1);
    expect(updated.averageRating).toBe(5);
  });

  it('blocks hiring an unverified provider', async () => {
    const unverifiedUser = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const prof = await inject('POST', '/api/v1/services/providers', { trade: 'electrician' }, unverifiedUser.token);
    expect(prof.json().data.isVerified).toBe(false);

    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('POST', '/api/v1/services/jobs', {
      providerId: prof.json().data.id,
      description: 'Rewire the whole house please, urgent job.',
    }, customer.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PROVIDER_NOT_VERIFIED');
  });
});
