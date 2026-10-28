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
import { providerChecklist } from '../modules/services/services.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { activateUserBlock } from '../modules/moderation/user-block.service';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-TRUST F2] A BLOCK ENDS CONTACT ON SERVICE JOBS TOO.
//
// Chat refuses a room across a block in either direction; a service job request
// opened one anyway (a job, a chat room with both people and a "New job request"
// notice). Now: the request is refused with the neutral USER_BLOCKED, lifecycle
// notices are not sent across a block, and a customer never sees the providers
// they blocked in the provider list.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: testPhone(),
        firstName: 'Block', lastName: `User${seq}`, roles, activeRole,
        isPhoneVerified: true, selfieCapturedAt: new Date(),
        avatar: 'storage://test/provider-selfie.jpg',
        ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sec-trust-f2', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const userIds = [...new Set(createdUserIds)];
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
    await app.prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }] } });
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:sec-trust-f2');
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

const block = (blockerId: string, blockedId: string) => runWithoutTenant(() =>
  activateUserBlock(app.prisma, { tenantId: 'swift-default', blockerId, blockedId }));
const noticesOfKind = async (userId: string, kind: string) => (await runWithoutTenant(() =>
  app.prisma.notification.findMany({ where: { userId }, select: { data: true } })))
  .filter((n) => (n.data as Record<string, unknown> | null)?.['kind'] === kind).length;

describe('[SEC-TRUST F2] a block in either direction ends contact through service jobs', () => {
  it.each(['provider blocked the customer', 'customer blocked the provider'] as const)('%s: the request is refused with the neutral answer, and no job, room or notice is made', async (who) => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    if (who === 'provider blocked the customer') await block(provider.userId, customer.userId);
    else await block(customer.userId, provider.userId);

    const res = await inject('POST', '/api/v1/services/jobs', { providerId: provider.providerId, description: 'Please come and fix the back door.' }, customer.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error?.code ?? res.json().code).toBe('USER_BLOCKED');
    expect(await jobsOf(customer.userId)).toEqual([]);
    expect(await roomsOf(customer.userId)).toBe(0);
    expect(await requestNoticesFor(provider.userId)).toBe(0);
  });

  it('a retry of a request made before the block is refused too (it does not hand back the earlier job)', async () => {
    const provider = await makeVerifiedProvider('plumber');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const body = { providerId: provider.providerId, description: 'The kitchen tap drips all night long.' };
    expect((await inject('POST', '/api/v1/services/jobs', body, customer.token)).statusCode).toBe(201);
    await block(provider.userId, customer.userId);
    const retry = await inject('POST', '/api/v1/services/jobs', body, customer.token);
    expect(retry.statusCode, retry.body).toBe(403);
    expect(await requestNoticesFor(provider.userId)).toBe(1);
  });

  it('a lifecycle notice is not sent across a block; the job still moves', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const made = await inject('POST', '/api/v1/services/jobs', { providerId: provider.providerId, description: 'Plane the bedroom door, it sticks.' }, customer.token);
    expect(made.statusCode, made.body).toBe(201);
    await block(customer.userId, provider.userId);
    const cancel = await inject('POST', `/api/v1/services/jobs/${made.json().data.id}/cancel`, { expectedUpdatedAt: made.json().data.updatedAt }, provider.token);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().data.status).toBe('CANCELLED');
    expect(await noticesOfKind(customer.userId, 'booking_cancelled')).toBe(0);
  });

  it('without a block the same lifecycle notice is sent', async () => {
    const provider = await makeVerifiedProvider('carpenter');
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const made = await inject('POST', '/api/v1/services/jobs', { providerId: provider.providerId, description: 'Hang a new kitchen cupboard door.' }, customer.token);
    const cancel = await inject('POST', `/api/v1/services/jobs/${made.json().data.id}/cancel`, { expectedUpdatedAt: made.json().data.updatedAt }, provider.token);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await noticesOfKind(customer.userId, 'booking_cancelled')).toBe(1);
  });

  it('a customer does not see the providers they blocked; other customers still do', async () => {
    const provider = await makeVerifiedProvider('electrician');
    const blocker = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const other = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await block(blocker.userId, provider.userId);
    const listed = async (token: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const res = await inject('GET', `/api/v1/services/providers?trade=electrician&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, token);
        expect(res.statusCode, res.body).toBe(200);
        ids.push(...res.json().data.providers.map((p: { id: string }) => p.id));
        cursor = res.json().data.page.nextCursor;
        if (!cursor) break;
      }
      return ids;
    };
    expect(await listed(other.token)).toContain(provider.providerId);
    expect(await listed(blocker.token)).not.toContain(provider.providerId);
  });
});
