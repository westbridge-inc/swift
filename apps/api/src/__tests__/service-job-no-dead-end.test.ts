import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER, SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION } from '@swift/types';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { servicesRoutes } from '../modules/services/services.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { DOC_REVIEWER_CAPABILITIES, SUPPORT_OPERATOR_CAPABILITIES } from '../modules/admin/admin-authority';
import { serviceJobCancelVerdict, VERY_LATE_AFTER_MIN } from '../modules/order/cancel-policy';
import { providerChecklist, refreshProviderVerification } from '../modules/services/services.service';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { grantStepUp } from './helpers/step-up';
import { testPhone } from './helpers/fixture-ids';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// Nobody is ever stuck with a job. A pro who never answers used to leave the customer with a booked job they could not
// cancel, Swift support had nothing to open, and the account could not be deleted either: each refusal pointed at the
// other. A quote job now follows the booking rule (free while the pro has not confirmed, free once the pro is very late),
// and a started job the customer cannot close is closed by Swift support, with a reason, both sides told, no money moved.
// The deletion block itself is untouched: it opens only because the job really closed.

const DAY = 86_400_000;
const MIN = 60_000;
let app: FastifyInstance;
let adminToken = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'service-job-no-dead-end');
let hour = 0;
const people: string[] = [];
const markets: string[] = [];

async function person(roles: UserRole[] = ['CUSTOMER'], extra: Record<string, unknown> = {}) {
  const role = roles[0]!;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Job', lastName: 'Door', roles, activeRole: role, isPhoneVerified: true, selfieCapturedAt: new Date(),
    avatar: `storage://test/job-door-${nanoid(8)}.jpg`, ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...extra,
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `job-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token };
}

async function pro() {
  const u = await person();
  const provider = await system(async () => {
    const created = await app.prisma.serviceProvider.create({ data: { userId: u.userId, trade: 'carpenter' } });
    for (const docType of await providerChecklist(app.prisma, u.userId)) {
      await app.prisma.verificationDocument.create({ data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    }
    await refreshProviderVerification(app.prisma, u.userId);
    return created;
  });
  return { ...u, providerId: provider.id };
}

const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({
  method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  headers: {
    authorization: `Bearer ${token}`, [SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER]: SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION,
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
  },
});
const row = (id: string) => system(() => app.prisma.serviceJob.findUniqueOrThrow({ where: { id } }));
async function generation(id: string) {
  const job = await row(id);
  return { expectedUpdatedAt: job.updatedAt.toISOString(), expectedScheduledFor: job.scheduledFor?.toISOString(), expectedQuoteAmount: Number(job.quoteAmount) };
}
const cancel = async (id: string, token: string) => call('POST', `/api/v1/services/jobs/${id}/cancel`, token, await generation(id));
const close = (id: string, reason: string | undefined = TEST_ADMIN_REASON, token = adminToken) => call('POST', `/api/v1/admin/service-jobs/${id}/close`, token, {}, reason ? { 'x-swift-reason': reason } : {});

/** The real road to a booked quote job: request, quote, the customer picks a time. */
async function booked(customer: { token: string }, provider: { token: string; providerId: string }) {
  hour += 3;
  const created = await call('POST', '/api/v1/services/jobs', customer.token, { providerId: provider.providerId, description: 'Fix a sagging kitchen cupboard door, photos attached.' });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id as string;
  expect((await call('POST', `/api/v1/services/jobs/${id}/quote`, provider.token, { amount: 8000, ...await generation(id) })).statusCode).toBe(200);
  const slot = new Date(Date.now() + 3 * DAY + hour * 60 * MIN * 60);
  const scheduled = await call('POST', `/api/v1/services/jobs/${id}/schedule`, customer.token, { scheduledFor: slot.toISOString(), ...await generation(id) });
  expect(scheduled.json().data?.status, scheduled.body).toBe('SCHEDULED');
  return id;
}
const confirm = async (id: string, provider: { token: string }) => {
  const res = await call('POST', `/api/v1/services/jobs/${id}/confirm`, provider.token, await generation(id));
  expect(res.statusCode, res.body).toBe(200);
};
const slotAgo = (id: string, minutes: number) => system(() => app.prisma.serviceJob.update({ where: { id }, data: { scheduledFor: new Date(Date.now() - minutes * MIN) } }));
const noticesFor = (userId: string) => system(() => app.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await person(['ADMIN'], { status: 'ACTIVE', admin: { create: { permissions: ['*'] } } });
  adminToken = admin.token;
});

afterAll(async () => {
  await system(async () => {
    const jobs = await app.prisma.serviceJob.findMany({ where: { OR: [{ customerId: { in: people } }, { provider: { userId: { in: people } } }] }, select: { id: true } });
    const ids = jobs.map((j) => j.id);
    await app.prisma.chatRoom.deleteMany({ where: { serviceJobId: { in: ids } } });
    await app.prisma.serviceJob.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await purgeAuditLogs(app.prisma, { userId: { in: people } }, 'test-cleanup:service-job-no-dead-end');
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: markets } } });
  });
  await app.close();
});

describe('a quote job the pro has not confirmed', () => {
  it('cancels free in the app, and the pro is told', async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    expect((await row(id)).providerConfirmedAt).toBeNull();
    const res = await cancel(id, customer.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('CANCELLED');
    expect(res.body).not.toMatch(/fee/i);
    expect((await noticesFor(provider.userId)).some((n) => n.title === 'Job cancelled')).toBe(true);
  });

  it('still cancels free two days after its slot passed, as measured when a pro never answers', async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    await slotAgo(id, 2 * 24 * 60);
    expect((await cancel(id, customer.token)).statusCode).toBe(200);
  });
});

describe('a quote job the pro confirmed', () => {
  it('before the slot: refused, with who to contact, nothing written', async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    await confirm(id, provider);
    const res = await cancel(id, customer.token);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SERVICE_JOB_BOOKED');
    expect((await row(id)).status).toBe('SCHEDULED');
  });

  it(`refused until ${VERY_LATE_AFTER_MIN} minutes past the slot, free from then`, async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    await confirm(id, provider);
    await slotAgo(id, VERY_LATE_AFTER_MIN - 1);
    expect((await cancel(id, customer.token)).statusCode).toBe(409);
    await slotAgo(id, VERY_LATE_AFTER_MIN);
    const res = await cancel(id, customer.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('CANCELLED');
  });

  it('the job the customer reads says the same as the route', async () => {
    const [customer, provider] = [await person(), await pro()];
    const request = await call('POST', '/api/v1/services/jobs', customer.token, { providerId: provider.providerId, description: 'Fix a sagging kitchen cupboard door, photos attached.' });
    expect((await call('GET', `/api/v1/services/jobs/${request.json().data.id}`, customer.token)).json().data.customerCancel).toBeUndefined();
    const id = await booked(customer, provider);
    const fresh = (await call('GET', `/api/v1/services/jobs/${id}`, customer.token)).json().data;
    expect(fresh.customerCancel).toMatchObject({ canCancel: true, cancelUnavailable: null });
    await confirm(id, provider);
    const confirmed = (await call('GET', '/api/v1/services/jobs', customer.token)).json().data.find((j: { id: string }) => j.id === id);
    expect(confirmed.customerCancel).toMatchObject({ canCancel: false, cancelUnavailable: { code: 'SERVICE_JOB_BOOKED' } });
    await slotAgo(id, VERY_LATE_AFTER_MIN);
    const late = (await call('GET', `/api/v1/services/jobs/${id}`, customer.token)).json().data;
    expect(late.customerCancel).toMatchObject({ canCancel: true, cancellationMessage: expect.stringMatching(/very late/) });
    expect((await call('GET', `/api/v1/services/jobs/${id}`, provider.token)).json().data.customerCancel).toBeUndefined();
  });
});

describe('a started job the customer cannot close', () => {
  async function started() {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    await confirm(id, provider);
    await slotAgo(id, 5);
    const res = await call('POST', `/api/v1/services/jobs/${id}/start`, provider.token, await generation(id));
    expect(res.statusCode, res.body).toBe(200);
    return { customer, provider, id };
  }

  it('the customer is still refused, however late', async () => {
    const { customer, id } = await started();
    await slotAgo(id, 3 * 24 * 60);
    const res = await cancel(id, customer.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SERVICE_JOB_STARTED');
  });

  it('Swift support closes it from admin: audited with the reason, both sides told, no money moved', async () => {
    const { customer, provider, id } = await started();
    const before = await row(id);
    const reason = 'Provider unreachable for three days, customer asked to close the job.';
    const res = await close(id, reason);
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(id);
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledAt).not.toBeNull();
    expect(Number(after.quoteAmount)).toBe(Number(before.quoteAmount));
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { entity: 'ServiceJob', entityId: id, action: 'SERVICE_JOB_CLOSED_BY_SWIFT' } }));
    expect(audit?.changes).toMatchObject({ from: 'IN_PROGRESS', to: 'CANCELLED', cancelledBy: 'SWIFT', reason });
    if (after.chatRoomId) expect((await system(() => app.prisma.chatRoom.findUniqueOrThrow({ where: { id: after.chatRoomId! } }))).isActive).toBe(false);
    for (const party of [customer, provider]) {
      const notice = (await noticesFor(party.userId)).find((n) => n.title === 'Job closed by Swift');
      expect(notice?.body).toMatch(/moved no money/);
      expect(notice?.body).not.toContain(reason);
    }
  });

  it('a support operator may close one; a document reviewer may not', async () => {
    const { id } = await started();
    const reviewer = await person(['ADMIN'], { status: 'ACTIVE', admin: { create: { permissions: [...DOC_REVIEWER_CAPABILITIES] } } });
    expect((await close(id, TEST_ADMIN_REASON, reviewer.token)).statusCode).toBe(403);
    const support = await person(['ADMIN'], { status: 'ACTIVE', admin: { create: { permissions: [...SUPPORT_OPERATOR_CAPABILITIES] } } });
    expect((await close(id, TEST_ADMIN_REASON, support.token)).statusCode).toBe(200);
  });

  it('a stated reason is required, a template is refused, a closed job stays closed, and a stranger gets nothing', async () => {
    const { customer, id } = await started();
    expect((await close(id, '')).statusCode).toBe(400);
    expect((await close(id, 'cancelled by admin')).statusCode).toBe(400);
    expect((await close(id, TEST_ADMIN_REASON, customer.token)).statusCode).toBe(403);
    expect((await row(id)).status).toBe('IN_PROGRESS');
    expect((await close(id)).statusCode).toBe(200);
    const again = await close(id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SERVICE_JOB_CLOSED');
    expect((await close('no-such-job')).statusCode).toBe(404);
  });
});

describe('another market', () => {
  it('its jobs cannot be listed or closed from here', async () => {
    const tenantId = `job-door-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
    await system(() => app.prisma.tenant.create({ data: { id: tenantId, name: 'Other market', slug: tenantId } }));
    markets.push(tenantId);
    const customer = await person(['CUSTOMER'], { tenantId });
    const other = await person(['CUSTOMER'], { tenantId });
    const provider = await system(() => app.prisma.serviceProvider.create({ data: { userId: other.userId, trade: 'carpenter', isVerified: true } }));
    const job = await system(() => app.prisma.serviceJob.create({ data: { customerId: customer.userId, providerId: provider.id, tenantId, description: 'Other market job', status: 'IN_PROGRESS' } }));
    expect((await call('GET', `/api/v1/admin/users/${customer.userId}/service-jobs`, adminToken)).json().data ?? []).toEqual([]);
    expect((await close(job.id)).statusCode).toBe(404);
    expect((await row(job.id)).status).toBe('IN_PROGRESS');
  });
});

describe('the rule itself, for every clock', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const job = (over: Record<string, unknown>) => ({ status: 'SCHEDULED', offeringId: null, scheduledFor: new Date(now.getTime() + DAY), providerConfirmedAt: null, ...over });
  const confirmedAt = new Date(now.getTime() - DAY);
  const past = (minutes: number) => new Date(now.getTime() - minutes * MIN);

  it('unconfirmed: free, whatever the clock', () => {
    expect(serviceJobCancelVerdict(job({}), now)).toEqual({ allowed: true, free: true, reason: 'NOT_ACCEPTED' });
    expect(serviceJobCancelVerdict(job({ scheduledFor: past(9_000) }), now)).toEqual({ allowed: true, free: true, reason: 'NOT_ACCEPTED' });
  });

  it('confirmed: the minute before the very-late line is refused, the line itself is free', () => {
    expect(serviceJobCancelVerdict(job({ providerConfirmedAt: confirmedAt, scheduledFor: new Date(past(VERY_LATE_AFTER_MIN).getTime() + 1) }), now)).toMatchObject({ allowed: false, code: 'SERVICE_JOB_BOOKED' });
    expect(serviceJobCancelVerdict(job({ providerConfirmedAt: confirmedAt, scheduledFor: past(VERY_LATE_AFTER_MIN) }), now)).toEqual({ allowed: true, free: true, reason: 'TOO_LATE' });
  });

  it('confirmed with no time on it: refused, never read as late', () => {
    expect(serviceJobCancelVerdict(job({ providerConfirmedAt: confirmedAt, scheduledFor: null }), now)).toMatchObject({ allowed: false, code: 'SERVICE_JOB_BOOKED' });
  });

  it('started: refused, however late', () => {
    expect(serviceJobCancelVerdict(job({ status: 'IN_PROGRESS', providerConfirmedAt: confirmedAt, scheduledFor: past(9_000) }), now)).toMatchObject({ allowed: false, code: 'SERVICE_JOB_STARTED' });
  });
});

describe('account deletion works through those doors and is not weakened', () => {
  const del = async (token: string) => { await grantStepUp(app, token); return call('DELETE', '/api/v1/customer/account', token); };

  it('a live job still refuses the deletion; the customer cancels it, then the deletion goes through', async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    const refused = await del(customer.token);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('ACTIVE_SERVICE_JOBS');
    expect((await cancel(id, customer.token)).statusCode).toBe(200);
    const gone = await del(customer.token);
    expect(gone.statusCode, gone.body).toBeLessThan(300);
  });

  it('a started job refuses it too, until Swift support has closed the job', async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    await confirm(id, provider);
    await slotAgo(id, 5);
    expect((await call('POST', `/api/v1/services/jobs/${id}/start`, provider.token, await generation(id))).statusCode).toBe(200);
    expect((await del(customer.token)).statusCode).toBe(409);
    expect((await close(id)).statusCode).toBe(200);
    const gone = await del(customer.token);
    expect(gone.statusCode, gone.body).toBeLessThan(300);
  });
});

describe('support can find a pro and their jobs', () => {
  it('the person page names the provider profile', async () => {
    const provider = await pro();
    const res = await call('GET', `/api/v1/admin/users/${provider.userId}`, adminToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.serviceProvider).toMatchObject({ id: provider.providerId, trade: 'carpenter', isVerified: true });
    const plain = await person();
    expect((await call('GET', `/api/v1/admin/users/${plain.userId}`, adminToken)).json().data.serviceProvider).toBeNull();
  });

  it('the job list reads from both sides, says whose job it is, and is admin only', async () => {
    const [customer, provider] = [await person(), await pro()];
    const id = await booked(customer, provider);
    for (const who of [customer, provider]) {
      const res = await call('GET', `/api/v1/admin/users/${who.userId}/service-jobs`, adminToken);
      expect(res.statusCode, res.body).toBe(200);
      const job = res.json().data.find((j: { id: string }) => j.id === id);
      expect(job).toMatchObject({ status: 'SCHEDULED', providerConfirmedAt: null, customer: { id: customer.userId }, provider: { userId: provider.userId, trade: 'carpenter' } });
      expect(job.customer.phone).toBeUndefined();
    }
    expect((await call('GET', `/api/v1/admin/users/${customer.userId}/service-jobs`, customer.token)).statusCode).toBe(403);
  });
});
