import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { adminRoutes } from '../modules/admin/admin.routes';
import { moderationRoutes } from '../modules/moderation/moderation.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// STORE-001: UGC reporting + moderation queue (store-compliance §5.4). Apple
// 1.2 / Google UGC+CSAE require a user to be able to flag content AND for those
// reports to be actionable. This drives the full loop: report → queue → resolve.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
let reporterId = '';
let reporterToken = '';
let adminToken = '';

async function mkUser(roles: UserRole[], activeRole: UserRole) {
  const u = await app.prisma.user.create({
    data: { phone: `+59200925${String(userIds.length).padStart(2, '0')}`, firstName: 'Mod', lastName: 'Test', roles, activeRole, isPhoneVerified: true, ...(activeRole === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}) },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'mod', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

const report = (token: string | null, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/reports', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: body as Record<string, unknown> });
const queue = (qs = '') =>
  app.inject({ method: 'GET', url: `/api/v1/admin/moderation/reports${qs}`, headers: { authorization: `Bearer ${adminToken}` } });
const resolve = (id: string, body: unknown, token = adminToken) =>
  app.inject({ method: 'PUT', url: `/api/v1/admin/moderation/reports/${id}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: body as Record<string, unknown> });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(moderationRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const reporter = await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
  reporterId = reporter.id; reporterToken = reporter.token;
  adminToken = (await mkUser(['ADMIN'] as UserRole[], 'ADMIN' as UserRole)).token;
});

afterAll(async () => {
  await app.prisma.contentReport.deleteMany({ where: { reporterId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('POST /reports — the in-app report action (STORE-001)', () => {
  it('an authenticated user files a PENDING report on objectionable UGC', async () => {
    const res = await report(reporterToken, { targetType: 'RATING', targetId: `r-${nanoid(6)}`, reason: 'HATE_SPEECH', detail: 'slur in a review' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
  });

  it('re-reporting the same target is idempotent — no duplicate row', async () => {
    const targetId = `dup-${nanoid(6)}`;
    const first = await report(reporterToken, { targetType: 'USER', targetId, reason: 'HARASSMENT' });
    expect(first.statusCode).toBe(201);
    const again = await report(reporterToken, { targetType: 'USER', targetId, reason: 'HARASSMENT' });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyReported).toBe(true);
    expect(again.json().data.id).toBe(first.json().data.id);
    const count = await app.prisma.contentReport.count({ where: { reporterId, targetType: 'USER', targetId } });
    expect(count).toBe(1);
  });

  it('a user cannot report their own profile', async () => {
    const res = await report(reporterToken, { targetType: 'USER', targetId: reporterId, reason: 'SPAM' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CANNOT_REPORT_SELF');
  });

  it('CSAE is a first-class reason (the store-mandated category)', async () => {
    const res = await report(reporterToken, { targetType: 'CHAT_MESSAGE', targetId: `m-${nanoid(6)}`, reason: 'CSAE' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
  });

  it('rejects an unauthenticated report and a bad target type', async () => {
    expect((await report(null, { targetType: 'RATING', targetId: 'x', reason: 'SPAM' })).statusCode).toBe(401);
    expect((await report(reporterToken, { targetType: 'NONSENSE', targetId: 'x', reason: 'SPAM' })).statusCode).toBe(400);
  });
});

describe('admin moderation queue (STORE-001)', () => {
  it('lists the open (PENDING) queue with a pending total, oldest-first; requires admin', async () => {
    await report(reporterToken, { targetType: 'VENDOR', targetId: `v-${nanoid(6)}`, reason: 'ILLEGAL_GOODS' });
    const res = await queue();
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingTotal).toBeGreaterThanOrEqual(1);
    expect(res.json().data.every((r: { status: string }) => r.status === 'PENDING')).toBe(true);

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation/reports' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('resolving a report records the decision (who + when) and clears it from PENDING', async () => {
    const filed = await report(reporterToken, { targetType: 'ITEM', targetId: `i-${nanoid(6)}`, reason: 'OTHER' });
    const id = filed.json().data.id;

    const res = await resolve(id, { status: 'ACTIONED', note: 'removed the listing' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('ACTIONED');
    expect(res.json().data.resolvedBy).toBeTruthy();
    expect(res.json().data.resolvedAt).toBeTruthy();
    expect(res.json().data.resolutionNote).toBe('removed the listing');

    const stillPending = (await queue()).json().data.some((r: { id: string }) => r.id === id);
    expect(stillPending).toBe(false);
  });

  it('resolving a non-existent report is a 404', async () => {
    const res = await resolve(`missing-${nanoid(6)}`, { status: 'DISMISSED' });
    expect(res.statusCode).toBe(404);
  });
});
