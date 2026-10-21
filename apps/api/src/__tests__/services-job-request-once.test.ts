import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import {
  SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER,
  SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
} from '@swift/types';
import { beginRequestTenantContext, prismaPlugin, runWithTenant, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import {
  createServiceJobWithLiveAuthority,
  providerChecklist,
  SERVICE_JOB_RETRY_WINDOW_MS,
} from '../modules/services/services.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [C2 server] A RETRIED SERVICE REQUEST NEVER CREATES A SECOND JOB.
//
// POST /services/jobs had no Idempotency-Key and no natural key. A customer on
// a slow network whose response was lost (or who tapped twice) sent the same
// request again and got a SECOND REQUESTED job, a second chat room and a
// second "New job request" notice to the provider. Phone builds 9/11 send no
// key and cannot be changed, so the server recognises the ask itself: the
// same customer, provider, words and photos, still unanswered, moments ago.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200193';
let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
        firstName: 'Once', lastName: `User${seq}`, roles, activeRole,
        isPhoneVerified: true, selfieCapturedAt: new Date(),
        avatar: 'storage://test/provider-selfie.jpg',
        ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'once', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
    },
  });
}

async function makeVerifiedProvider(trade: string) {
  const u = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
  const profile = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  expect(profile.statusCode, profile.body).toBeLessThan(300);
  const checklist = await runWithoutTenant(() => providerChecklist(app.prisma, u.userId));
  expect(checklist.length).toBeGreaterThan(0);
  for (const docType of checklist) {
    await runWithoutTenant(() => app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    }));
  }
  const res = await inject('POST', '/api/v1/services/providers', { trade, bio: 'Experienced' }, u.token);
  expect(res.json().data.isVerified).toBe(true);
  return { ...u, providerId: res.json().data.id as string };
}

const jobsOf = (customerId: string) => runWithoutTenant(() =>
  app.prisma.serviceJob.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }));
const roomsOf = (customerId: string) => runWithoutTenant(() =>
  app.prisma.chatRoom.count({ where: { participants: { some: { userId: customerId } } } }));
const requestNoticesFor = async (providerUserId: string) => (await runWithoutTenant(() =>
  app.prisma.notification.findMany({ where: { userId: providerUserId }, select: { data: true } })))
  .filter((n) => (n.data as Record<string, unknown> | null)?.['kind'] === 'booking_requested').length;

/** True once another session is parked on the service-job User-row lock. */
async function waitForBlockedJobAuthorityLock(): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows = await app.prisma.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%service-job-live-authority%'
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The second copy neither reached the authority check nor waited on the User-row lock');
}

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const userIds = [...new Set([...createdUserIds, ...users.map((user) => user.id)])];
    createdUserIds.length = 0;
    if (userIds.length === 0) return;
    const jobs = await app.prisma.serviceJob.findMany({
      where: { OR: [{ customerId: { in: userIds } }, { provider: { userId: { in: userIds } } }] },
      select: { id: true },
    });
    const jobIds = jobs.map((j) => j.id);
    await app.prisma.chatRoom.deleteMany({ where: { serviceJobId: { in: jobIds } } });
    await app.prisma.serviceJob.deleteMany({ where: { id: { in: jobIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:services-once');
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('[C2 server] POST /services/jobs — a retry is the same request (no Idempotency-Key: builds 9/11)', () => {
  it('the same request sent twice = one job, one chat room, one notice; the retry gets the first job back', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'Rehang the back gate, it drags on the ground.', photos: ['storage://test/gate.jpg'] };

    const first = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(first.statusCode, first.body).toBe(201);
    const retry = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(retry.statusCode, retry.body).toBe(201);

    expect(retry.json().data.id, 'the retry must answer with the FIRST job').toBe(first.json().data.id);
    expect(retry.json().data.chatRoomId).toBe(first.json().data.chatRoomId);
    expect(retry.json().data.status).toBe('REQUESTED');
    expect((await jobsOf(customer.userId)).map((j) => j.id)).toEqual([first.json().data.id]);
    expect(await roomsOf(customer.userId)).toBe(1);
    expect(await requestNoticesFor(provider.userId), 'the provider is told once').toBe(1);
  });

  it('two copies of one request racing each other still make one job and one room', async () => {
    const provider = await makeVerifiedProvider('plumber');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'The kitchen tap drips all night long.' };

    const [a, b] = await Promise.all([
      inject('POST', '/api/v1/services/jobs', body, customer.token),
      inject('POST', '/api/v1/services/jobs', body, customer.token),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().data.id).toBe(b.json().data.id);
    expect(await jobsOf(customer.userId)).toHaveLength(1);
    expect(await roomsOf(customer.userId)).toBe(1);
    expect(await requestNoticesFor(provider.userId)).toBe(1);
  });

  it('different requests stay different: other words, other photos, another provider = separate jobs and rooms', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const other = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const base = { providerId: provider.providerId, description: 'Fit two new shelves in the pantry please.' };

    const sent = [
      await inject('POST', '/api/v1/services/jobs', base, customer.token),
      await inject('POST', '/api/v1/services/jobs', { ...base, description: 'Fit three new shelves in the pantry please.' }, customer.token),
      await inject('POST', '/api/v1/services/jobs', { ...base, photos: ['storage://test/pantry.jpg'] }, customer.token),
      await inject('POST', '/api/v1/services/jobs', { ...base, providerId: other.providerId }, customer.token),
    ];
    for (const res of sent) expect(res.statusCode, res.body).toBe(201);
    expect(new Set(sent.map((res) => res.json().data.id)).size).toBe(4);
    expect(await jobsOf(customer.userId)).toHaveLength(4);
    expect(await roomsOf(customer.userId)).toBe(4);
    expect(await requestNoticesFor(provider.userId)).toBe(3);
    expect(await requestNoticesFor(other.userId)).toBe(1);
  });

  it('two customers asking the same provider the same thing get a job each', async () => {
    const provider = await makeVerifiedProvider('plumber');
    const customerA = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const customerB = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'Unblock the bathroom sink drain.' };

    const a = await inject('POST', '/api/v1/services/jobs', body, customerA.token);
    const b = await inject('POST', '/api/v1/services/jobs', body, customerB.token);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().data.id).not.toBe(b.json().data.id);
    expect(await requestNoticesFor(provider.userId)).toBe(2);
  });

  it('two copies held side by side at the authority check: the User-row lock makes the second see the first', async () => {
    // Deterministic race: copy A pauses right after its authority check until
    // copy B is either at the same point (no lock: both would create) or seen
    // parked on the customer's User-row lock (the real code).
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    let arrived = 0;
    let releaseFirst!: () => void;
    const bothArrived = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const observer = {
      afterAuthorityChecked: async () => {
        arrived += 1;
        if (arrived > 1) { releaseFirst(); return; }
        await Promise.race([bothArrived, waitForBlockedJobAuthorityLock()]);
      },
    };
    const ask = () => runWithTenant('swift-default', () => createServiceJobWithLiveAuthority(app.prisma, {
      customerId: customer.userId,
      tenantId: 'swift-default',
      providerId: provider.providerId,
      description: 'Build a small bookcase for the bedroom.',
      photos: [],
    }, observer));

    const [a, b] = await Promise.all([ask(), ask()]);
    expect(a.job.id).toBe(b.job.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await jobsOf(customer.userId)).toHaveLength(1);
    expect(await roomsOf(customer.userId)).toBe(1);
  });

  it('once the provider has answered (quoted), the same words again are a NEW request', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'Replace the broken hinge on the wardrobe.' };

    const first = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(first.statusCode).toBe(201);
    const quoted = await inject('POST', `/api/v1/services/jobs/${first.json().data.id}/quote`, {
      amount: 5000, expectedUpdatedAt: first.json().data.updatedAt,
    }, provider.token);
    expect(quoted.statusCode, quoted.body).toBe(200);

    const again = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(again.statusCode).toBe(201);
    expect(again.json().data.id).not.toBe(first.json().data.id);
    expect(again.json().data.status).toBe('REQUESTED');
    expect(await jobsOf(customer.userId)).toHaveLength(2);
    expect(await roomsOf(customer.userId)).toBe(2);
  });

  it('outside the short window the same words are a NEW request', async () => {
    const provider = await makeVerifiedProvider('plumber');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'Fix the running toilet cistern.' };

    const first = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(first.statusCode).toBe(201);
    // The first request was sent just over the window ago.
    await runWithoutTenant(() => app.prisma.serviceJob.update({
      where: { id: first.json().data.id },
      data: { createdAt: new Date(Date.now() - SERVICE_JOB_RETRY_WINDOW_MS - 1_000) },
    }));

    const later = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(later.statusCode).toBe(201);
    expect(later.json().data.id).not.toBe(first.json().data.id);
    expect(await jobsOf(customer.userId)).toHaveLength(2);
    expect(await requestNoticesFor(provider.userId)).toBe(2);
  });
});
