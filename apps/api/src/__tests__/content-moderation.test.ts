import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
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
let adminId = '';
let authorId = '';
let raceAuthorId = '';
let snapshotAuthorId = '';
let otherTenantUserId = '';
let chatMessageId = '';
const TENANT_B = 'launch2-report-tenant';
const runPhoneSuffix = String(Date.now()).slice(-5);

async function mkUser(roles: UserRole[], activeRole: UserRole, tenantId = 'swift-default') {
  const u = await app.prisma.user.create({
    data: { tenantId, phone: `+59200988${runPhoneSuffix}${String(userIds.length).padStart(2, '0')}`, firstName: 'Mod', lastName: 'Test', roles, activeRole, isPhoneVerified: true, ...(activeRole === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}) },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'mod', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

const report = (token: string | null, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/reports', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: body as Record<string, unknown> });
const queue = (qs = '') =>
  app.inject({ method: 'GET', url: `/api/v1/admin/moderation/reports${qs}`, headers: { authorization: `Bearer ${adminToken}` } });
const resolve = (id: string, body: unknown, token = adminToken) =>
  app.inject({ method: 'PUT', url: `/api/v1/admin/moderation/reports/${id}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: body as Record<string, unknown> });

async function findQueuedReport(id: string) {
  const first = await queue('?limit=50');
  expect(first.statusCode).toBe(200);
  const firstBody = first.json();
  const onFirstPage = firstBody.data.find((row: { id: string }) => row.id === id);
  if (onFirstPage) return onFirstPage;

  const lastPage = firstBody.meta.totalPages as number;
  if (lastPage <= 1) return undefined;
  const last = await queue(`?limit=50&page=${lastPage}`);
  expect(last.statusCode).toBe(200);
  return last.json().data.find((row: { id: string }) => row.id === id);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test2';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382/14';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  // Match production: authentication mutates a fresh per-request tenant store.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(moderationRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  await runWithoutTenant(async () => {
    await app.prisma.tenant.upsert({
      where: { id: TENANT_B },
      update: {},
      create: { id: TENANT_B, name: 'Launch 2 report tenant', slug: TENANT_B },
    });
  });

  const reporter = await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
  reporterId = reporter.id; reporterToken = reporter.token;
  const admin = await mkUser(['ADMIN'] as UserRole[], 'ADMIN' as UserRole);
  adminToken = admin.token; adminId = admin.id;
  const author = await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
  authorId = author.id;
  raceAuthorId = (await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole)).id;
  snapshotAuthorId = (await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole)).id;
  otherTenantUserId = (await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole, TENANT_B)).id;

  const room = await app.prisma.chatRoom.create({
    data: {
      participants: { create: [
        { userId: reporterId, role: 'CUSTOMER' },
        { userId: authorId, role: 'CUSTOMER' },
      ] },
      messages: { create: { senderId: authorId, message: 'real reportable chat message' } },
    },
    include: { messages: { select: { id: true } } },
  });
  chatMessageId = room.messages[0]!.id;
});

afterAll(async () => {
  // ContentReport is intentionally retained: reports are audit evidence, even
  // in tests. Random real target ids and the dedicated phone prefix prevent
  // fixture collisions without weakening that invariant.
  await runWithoutTenant(async () => {
    await app.prisma.chatRoom.deleteMany({ where: { participants: { some: { userId: { in: userIds } } } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('POST /reports — the in-app report action (STORE-001)', () => {
  it('an authenticated user files a PENDING report on objectionable UGC', async () => {
    const res = await report(reporterToken, { targetType: 'USER', targetId: adminId, reason: 'HATE_SPEECH', detail: 'objectionable profile content' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
    await expect(app.prisma.contentReport.findUnique({ where: { id: res.json().data.id } }))
      .resolves.toMatchObject({ tenantId: 'swift-default', reporterId });
  });

  it('re-reporting the same target is idempotent — no duplicate row', async () => {
    const first = await report(reporterToken, { targetType: 'USER', targetId: authorId, reason: 'HARASSMENT' });
    expect(first.statusCode).toBe(201);
    const again = await report(reporterToken, { targetType: 'USER', targetId: authorId, reason: 'HARASSMENT' });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyReported).toBe(true);
    expect(again.json().data.id).toBe(first.json().data.id);
    const count = await app.prisma.contentReport.count({ where: { reporterId, targetType: 'USER', targetId: authorId } });
    expect(count).toBe(1);
  });

  it('concurrent duplicate taps converge on one audit row', async () => {
    const payload = { targetType: 'USER', targetId: raceAuthorId, reason: 'SPAM' };
    const [first, second] = await Promise.all([
      report(reporterToken, payload),
      report(reporterToken, payload),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(first.json().data.id).toBe(second.json().data.id);
    await expect(app.prisma.contentReport.count({
      where: { reporterId, targetType: 'USER', targetId: raceAuthorId },
    })).resolves.toBe(1);
  });

  it('a user cannot report their own profile', async () => {
    const res = await report(reporterToken, { targetType: 'USER', targetId: reporterId, reason: 'SPAM' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CANNOT_REPORT_SELF');
  });

  it('CSAE is a first-class reason (the store-mandated category)', async () => {
    const res = await report(reporterToken, { targetType: 'CHAT_MESSAGE', targetId: chatMessageId, reason: 'CSAE' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
  });

  it('rejects phantom, inaccessible, and cross-tenant targets without revealing which case failed', async () => {
    const phantom = await report(reporterToken, { targetType: 'USER', targetId: `ghost-${nanoid(6)}`, reason: 'SPAM' });
    const crossTenant = await report(reporterToken, { targetType: 'USER', targetId: otherTenantUserId, reason: 'SPAM' });
    const inaccessibleChat = await report(adminToken, { targetType: 'CHAT_MESSAGE', targetId: chatMessageId, reason: 'SPAM' });

    for (const res of [phantom, crossTenant, inaccessibleChat]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('REPORT_TARGET_NOT_FOUND');
    }
  });

  it('hard-delete is refused because reports are audit evidence', async () => {
    await expect(app.prisma.contentReport.deleteMany({ where: { reporterId } }))
      .rejects.toThrow(/hard-delete is not permitted/);
  });

  it('rejects an unauthenticated report and a bad target type', async () => {
    expect((await report(null, { targetType: 'RATING', targetId: 'x', reason: 'SPAM' })).statusCode).toBe(401);
    expect((await report(reporterToken, { targetType: 'NONSENSE', targetId: 'x', reason: 'SPAM' })).statusCode).toBe(400);
  });
});

describe('admin moderation queue (STORE-001)', () => {
  it('lists the open (PENDING) queue with a pending total, oldest-first; requires admin', async () => {
    const res = await queue();
    expect(res.statusCode).toBe(200);
    expect(res.json().pendingTotal).toBeGreaterThanOrEqual(1);
    expect(res.json().data.every((r: { status: string }) => r.status === 'PENDING')).toBe(true);

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation/reports' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('resolving a report records the decision (who + when) and clears it from PENDING', async () => {
    const filed = await report(reporterToken, { targetType: 'CHAT_MESSAGE', targetId: chatMessageId, reason: 'CSAE' });
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

  it('STORE-002: the queue enriches each row with the real reported content', async () => {
    // The immutable report snapshot must remain reviewable after the author
    // edits the live profile, and retained prior test runs may span many pages.
    const filed = await report(reporterToken, {
      targetType: 'USER', targetId: snapshotAuthorId, reason: 'HARASSMENT',
    });
    expect(filed.statusCode).toBe(201);
    await app.prisma.user.update({
      where: { id: snapshotAuthorId },
      data: { firstName: 'EditedAfterReport' },
    });

    const userRow = await findQueuedReport(filed.json().data.id) as {
      targetType: string;
      targetId: string;
      target: { firstName?: string } | null;
    } | undefined;
    expect(userRow?.target).toBeTruthy();
    expect(userRow?.target?.firstName).toBe('Mod'); // the author's name at report time
  });
});
