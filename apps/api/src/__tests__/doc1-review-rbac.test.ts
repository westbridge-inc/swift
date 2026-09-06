/**
 * [DOC-1 §8.4 · P8-4] test_support_cannot_read_documents — DOC-INV-19.
 *
 * The review console's roles are capability presets an admin grant is made
 * from, and the server honours the narrowing. SUPPORT reads counts and never
 * a document, a case's fields, a name or a phone; DOC_REVIEWER reads the
 * queue, renders (logged), decides and claims — but places no hold and
 * administers no registry; DOC_SENIOR adds the clearance outcome; DOC_ADMIN
 * holds everything under verification.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import {
  ADMIN_CAPABILITIES, ADMIN_ROUTE_AUTHORITY, REVIEW_CONSOLE_PRESETS,
  DOC_REVIEWER_CAPABILITIES, DOC_SENIOR_CAPABILITIES, DOC_ADMIN_CAPABILITIES, SUPPORT_OPERATOR_CAPABILITIES, holdsCapability,
} from '../modules/admin/admin-authority';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Reviewed against the registry ${RUN}; legible and current`;
/** Capabilities a preset may declare AHEAD of a route (the clearance outcome route is not built yet) — pinned so a typo cannot hide here. */
const DECLARED_AHEAD = ['verification.clearance.read'];

let app: FastifyInstance;
const users: string[] = [];
let subjectId = '';
let subjectPhone = '';
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-review-rbac-test');

async function admin(permissions: readonly string[]) {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59280${NUM}${seq}`, firstName: 'Rbac', lastName: `Admin${seq}`, roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: [...permissions] } },
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rbac-${RUN}-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { id: u.id, token };
}
const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => app.inject({
  method, url: `/api/v1/admin${url}`, ...(payload !== undefined ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
async function pendingDoc() {
  return runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
    userId: subjectId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: '', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  subjectPhone = `+59280${NUM}0`;
  const s = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: subjectPhone, firstName: `Zelda${RUN}`, lastName: 'Subject', activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true } }));
  subjectId = s.id; users.push(subjectId);
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: subjectId }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: subjectId } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: subjectId }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: subjectId } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P8-4] the review console roles, as capability presets the server honours', () => {
  it('the presets are made only of capabilities a route registers (or is declared ahead), and the §8.4 table holds: SUPPORT counts only; reviewer no holds; DOC_ADMIN everything under verification', () => {
    for (const [name, caps] of Object.entries(REVIEW_CONSOLE_PRESETS)) {
      for (const cap of caps) {
        if (cap.endsWith('.*')) continue;
        expect(ADMIN_CAPABILITIES.includes(cap) || DECLARED_AHEAD.includes(cap), `${name} names ${cap}, which no route registers`).toBe(true);
      }
    }
    const forbiddenForSupport = ['verification.read', 'verification.document.read', 'verification.decide', 'verification.hold', 'verification.hold.read', 'verification.case.claim'];
    for (const cap of forbiddenForSupport) expect(holdsCapability(SUPPORT_OPERATOR_CAPABILITIES, cap), `SUPPORT must not hold ${cap}`).toBe(false);
    expect(holdsCapability(SUPPORT_OPERATOR_CAPABILITIES, 'verification.counts')).toBe(true);
    for (const cap of ['verification.hold', 'verification.hold.read', 'verification.clearance.read']) expect(holdsCapability(DOC_REVIEWER_CAPABILITIES, cap), `a reviewer must not hold ${cap}`).toBe(false);
    for (const cap of ['verification.read', 'verification.document.read', 'verification.decide', 'verification.case.claim']) expect(holdsCapability(DOC_REVIEWER_CAPABILITIES, cap)).toBe(true);
    expect(holdsCapability(DOC_SENIOR_CAPABILITIES, 'verification.clearance.read')).toBe(true);
    expect(holdsCapability(DOC_SENIOR_CAPABILITIES, 'verification.hold')).toBe(false);
    for (const cap of ['verification.read', 'verification.hold', 'verification.hold.read', 'verification.decide', 'verification.clearance.read', 'verification.counts']) expect(holdsCapability(DOC_ADMIN_CAPABILITIES, cap)).toBe(true);
    expect(ADMIN_ROUTE_AUTHORITY['GET /verification/queue/counts']).toMatchObject({ cls: 'C0', capability: 'verification.counts' });
  });

  it('test_support_cannot_read_documents: SUPPORT is refused the queue, a render, a decision, a hold and a claim — and gets counts that carry no one’s name, phone or file', async () => {
    const doc = await pendingDoc();
    const support = await admin(SUPPORT_OPERATOR_CAPABILITIES);
    expect((await call(support.token, 'GET', '/verification/queue?status=PENDING')).statusCode).toBe(403);
    expect((await call(support.token, 'GET', `/verification/${doc.id}/document-url`)).statusCode).toBe(403);
    expect((await call(support.token, 'PUT', `/verification/${doc.id}/approve`, {})).statusCode).toBe(403);
    expect((await call(support.token, 'PUT', `/verification/${doc.id}/reject`, { reason: REASON, reasonCode: 'UNREADABLE' })).statusCode).toBe(403);
    expect((await call(support.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() })).statusCode).toBe(403);
    expect((await call(support.token, 'GET', '/verification/legal-holds')).statusCode).toBe(403);
    const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
    expect((await call(support.token, 'POST', `/verification/cases/${kase.id}/claim`, {})).statusCode).toBe(403);
    const counts = await call(support.token, 'GET', '/verification/queue/counts');
    expect(counts.statusCode).toBe(200);
    expect(counts.json().data.byStatus.PENDING).toBeGreaterThanOrEqual(1);
    expect(counts.json().data.openCases).toBeGreaterThanOrEqual(1);
    const text = counts.body;
    expect(text).not.toContain(`Zelda${RUN}`);
    expect(text).not.toContain(subjectPhone);
    expect(text).not.toMatch(/fileUrl|firstName|phone|docType|userId/);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('PENDING');
  });

  it('DOC_REVIEWER reads the queue with the person on it, renders (past the guard), claims and decides — but may neither place nor list a hold', async () => {
    const doc = await pendingDoc();
    const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
    const reviewer = await admin(DOC_REVIEWER_CAPABILITIES);
    const queue = await call(reviewer.token, 'GET', '/verification/queue?status=PENDING');
    expect(queue.statusCode).toBe(200);
    expect(queue.body).toContain(`Zelda${RUN}`);
    expect((await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`)).statusCode).not.toBe(403);
    expect((await call(reviewer.token, 'POST', `/verification/cases/${kase.id}/claim`, {})).statusCode).toBe(200);
    expect((await call(reviewer.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() })).statusCode).toBe(403);
    expect((await call(reviewer.token, 'GET', '/verification/legal-holds')).statusCode).toBe(403);
    const approved = await call(reviewer.token, 'PUT', `/verification/${doc.id}/approve`, {});
    expect(approved.statusCode).toBe(200);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('APPROVED');
  });

  it('DOC_ADMIN places and lists holds; the counts endpoint answers every preset that holds verification.counts', async () => {
    await pendingDoc();
    const docAdmin = await admin(DOC_ADMIN_CAPABILITIES);
    const placed = await call(docAdmin.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(placed.statusCode).toBe(201);
    expect((await call(docAdmin.token, 'GET', '/verification/legal-holds')).statusCode).toBe(200);
    expect((await call(docAdmin.token, 'GET', '/verification/queue/counts')).statusCode).toBe(200);
    const senior = await admin(DOC_SENIOR_CAPABILITIES);
    expect((await call(senior.token, 'GET', '/verification/queue/counts')).statusCode).toBe(200);
    expect((await call(senior.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() })).statusCode).toBe(403);
  });
});
