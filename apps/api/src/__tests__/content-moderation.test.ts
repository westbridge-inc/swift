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
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

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

async function mkUser(roles: UserRole[], activeRole: UserRole) {
  const u = await app.prisma.user.create({
    data: { phone: `+59200925${String(userIds.length).padStart(2, '0')}`, firstName: 'Mod', lastName: 'Test', roles, activeRole, isPhoneVerified: true, ...(activeRole === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}) },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: u.id, token, refreshToken: nanoid(48), deviceId: 'mod', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

const report = (token: string | null, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/v1/reports', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: body as Record<string, unknown> });
const queue = (qs = '') =>
  app.inject({ method: 'GET', url: `/api/v1/admin/moderation/reports${qs}`, headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` } });
const resolve = (id: string, body: unknown, token = adminToken) =>
  app.inject({ method: 'PUT', url: `/api/v1/admin/moderation/reports/${id}`, headers: { 'x-swift-reason': TEST_ADMIN_REASON,  'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: body as Record<string, unknown> });

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
  const admin = await mkUser(['ADMIN'] as UserRole[], 'ADMIN' as UserRole);
  adminToken = admin.token; adminId = admin.id;
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

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/admin/moderation/reports', headers: { 'x-swift-reason': TEST_ADMIN_REASON } });
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

  it('STORE-002: the queue enriches each row with the reported content (or null if gone)', async () => {
    // Report a REAL user (the admin) — the row should carry that user's snapshot.
    await report(reporterToken, { targetType: 'USER', targetId: adminId, reason: 'HARASSMENT' });
    // Report a target that does not exist — its snapshot should be null.
    const ghostId = `ghost-${nanoid(6)}`;
    await report(reporterToken, { targetType: 'ITEM', targetId: ghostId, reason: 'OTHER' });

    const rows = (await queue()).json().data as Array<{ targetType: string; targetId: string; target: { firstName?: string } | null }>;
    const userRow = rows.find((r) => r.targetType === 'USER' && r.targetId === adminId);
    expect(userRow?.target).toBeTruthy();
    expect(userRow?.target?.firstName).toBe('Mod'); // the admin's seeded first name

    const ghostRow = rows.find((r) => r.targetType === 'ITEM' && r.targetId === ghostId);
    expect(ghostRow?.target).toBeNull(); // content already gone
  });
});


// ---------------------------------------------------------------------------
// [A-17] A CHILD-SAFETY REPORT DOES NOT CLOSE LIKE A SPAM REPORT.
//
// Swift's published child-safety standards promise that confirmed material is
// removed, the account banned, the matter reported to the relevant authorities,
// and the evidence preserved. A CSAE report used to close on one click with an
// OPTIONAL note — so "handled" and "nobody looked properly" produced identical
// rows, and the platform could not show that the promise had been kept once.
// ---------------------------------------------------------------------------
async function csaeReport() {
  const target = await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
  const filed = await report(reporterToken, { targetType: 'USER', targetId: target.id, reason: 'CSAE', detail: 'child safety' });
  expect(filed.statusCode).toBe(201);
  return filed.json().data.id as string;
}

describe('[A-17] closing a child-safety report needs a decision, evidence, and two people', () => {
  it('one click to ACTIONED is refused — a coded disposition is required, not a note', async () => {
    const id = await csaeReport();
    const res = await resolve(id, { status: 'ACTIONED', note: 'handled it' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CSAE_CLOSURE_INCOMPLETE');
    const row = await app.prisma.contentReport.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.resolvedAt).toBeNull();
  });

  it('"ENFORCED" without naming what was enforced, or preserving evidence, is refused', async () => {
    const id = await csaeReport();
    const bare = await resolve(id, { status: 'ACTIONED', disposition: 'ENFORCED' });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.details.problems.join(' ')).toMatch(/name what was enforced/);

    const noPreservation = await resolve(id, { status: 'ACTIONED', disposition: 'ENFORCED', enforcementRef: 'user:banned:abc123' });
    expect(noPreservation.statusCode).toBe(400);
    expect(noPreservation.json().error.details.problems.join(' ')).toMatch(/evidence has been preserved/);
  });

  it('an enforcement outcome closes with what was done and the evidence preserved', async () => {
    const id = await csaeReport();
    const res = await resolve(id, {
      status: 'ACTIONED', disposition: 'ENFORCED',
      enforcementRef: 'user:banned:abc123', evidencePreserved: true, note: 'account banned, content removed',
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await app.prisma.contentReport.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIONED');
    expect(row.disposition).toBe('ENFORCED');
    expect(row.enforcementRef).toBe('user:banned:abc123');
    expect(row.evidencePreserved).toBe(true);
    expect(row.resolvedBy).toBe(adminId);
  });

  it('"reported to an authority" must name the report it claims to have made', async () => {
    const id = await csaeReport();
    const unnamed = await resolve(id, {
      status: 'ACTIONED', disposition: 'ENFORCED_AND_REPORTED',
      enforcementRef: 'user:banned:def456', evidencePreserved: true,
    });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().error.details.problems.join(' ')).toMatch(/name the report made to the authority/);

    const named = await resolve(id, {
      status: 'ACTIONED', disposition: 'ENFORCED_AND_REPORTED',
      enforcementRef: 'user:banned:def456', evidencePreserved: true, authorityRef: 'NCMEC-2026-00417',
    });
    expect(named.statusCode, named.body).toBe(200);
    expect((await app.prisma.contentReport.findUniqueOrThrow({ where: { id } })).authorityRef).toBe('NCMEC-2026-00417');
  });

  it('a dismissal takes TWO people — and not the same one twice', async () => {
    const id = await csaeReport();

    // Straight to DISMISSED: refused, nobody has proposed it.
    const straight = await resolve(id, { status: 'DISMISSED', disposition: 'NO_VIOLATION' });
    expect(straight.statusCode).toBe(400);
    expect(straight.json().error.details.problems.join(' ')).toMatch(/proposed first/);

    // The first reviewer proposes. The report stays OPEN.
    const proposed = await resolve(id, { status: 'PROPOSE_DISMISS', disposition: 'NO_VIOLATION', note: 'reviewed against policy' });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const midway = await app.prisma.contentReport.findUniqueOrThrow({ where: { id } });
    expect(midway.status).toBe('REVIEWING');
    expect(midway.resolvedAt).toBeNull();
    expect(midway.dismissProposedBy).toBe(adminId);

    // The SAME person cannot confirm their own proposal.
    const selfConfirm = await resolve(id, { status: 'DISMISSED', disposition: 'NO_VIOLATION' });
    expect(selfConfirm.statusCode).toBe(400);
    expect(selfConfirm.json().error.details.problems.join(' ')).toMatch(/different person/);
    expect((await app.prisma.contentReport.findUniqueOrThrow({ where: { id } })).status).toBe('REVIEWING');

    // A second reviewer can.
    const second = await mkUser(['ADMIN'] as UserRole[], 'ADMIN' as UserRole);
    const confirmed = await resolve(id, { status: 'DISMISSED', disposition: 'NO_VIOLATION' }, second.token);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const closed = await app.prisma.contentReport.findUniqueOrThrow({ where: { id } });
    expect(closed.status).toBe('DISMISSED');
    expect(closed.resolvedBy).toBe(second.id);
    expect(closed.dismissProposedBy).toBe(adminId);
  });

  it('the disposition and the status must agree', async () => {
    const id = await csaeReport();
    const wrongWay = await resolve(id, { status: 'ACTIONED', disposition: 'NO_VIOLATION' });
    expect(wrongWay.statusCode).toBe(400);
    expect(wrongWay.json().error.details.problems.join(' ')).toMatch(/not an enforcement outcome/);
  });

  it('ORDINARY moderation is untouched — a spam report still closes on one click', async () => {
    const target = await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole);
    const filed = await report(reporterToken, { targetType: 'USER', targetId: target.id, reason: 'SPAM' });
    const id = filed.json().data.id;
    const res = await resolve(id, { status: 'ACTIONED', note: 'obvious spam' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.contentReport.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIONED');
    // …and a proposed dismissal is not a thing outside child safety.
    const other = await report(reporterToken, { targetType: 'USER', targetId: (await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole)).id, reason: 'SPAM' });
    const proposal = await resolve(other.json().data.id, { status: 'PROPOSE_DISMISS' });
    expect(proposal.statusCode).toBe(400);
    expect(proposal.json().error.code).toBe('PROPOSAL_NOT_APPLICABLE');
  });
});
