/**
 * [VERIFY-DOCS] REVIEWERS TYPE WHAT THE KEPT RECORD NEEDS, AT APPROVAL.
 *
 * Owner ruling, 6 Oct 2026 (21:25 GYT): "Reviewers TYPE at approval: the police
 * clearance issue date (yearly re-check) + the ID/licence number (stored as a
 * blind index, only for duplicate-account checks)"; coordinator ruling the same
 * evening: "a licence-number duplicate signal comes from the typed licence
 * number".
 *
 * With manual review (staging and production run KYC_PROVIDER=manual) nothing
 * is extracted, so before this change:
 *   - an approved national ID left no identity number at all — the duplicate
 *     account (trial-abuse) check never saw one, and motorised movers may now
 *     give a licence instead of an ID (PR-V1), which no check ever read;
 *   - a police clearance carries an ISSUE date, not a printed expiry, and the
 *     reviewer was asked for an expiry the document does not print.
 *
 * Now the approval asks for exactly what the document type needs:
 *   - national ID / owner's ID / passport / L2 identity: the number → a HARD
 *     ID_DOC_NUMBER identity key (an HMAC blind index; the number itself is
 *     stored nowhere);
 *   - driver's licence: the licence number → the same key type, in its own
 *     namespace (a licence number never matches an ID number);
 *   - police clearance: the issue date → kept on the document's record, and
 *     the re-check falls due one year after it.
 * The queue tells the console which of these each document needs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createHmac } from 'node:crypto';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { clusterMemberIds } from '../modules/integrity/identity.service';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Typed-field review ${RUN}: checked against the document`;
// The same salt the identity service uses outside production (normalize.ts).
const blind = (normalized: string) => createHmac('sha256', process.env['IDENTITY_SALT'] || 'dev-identity-salt').update(normalized).digest('hex');

let app: FastifyInstance;
let adminToken = '';
const users: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'reviewer-typed-fields-test');

async function subject(role: 'MOVER' | 'VENDOR_OWNER' = 'MOVER') {
  seq += 1;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+59278${NUM}${String(seq).padStart(2, '0')}`, firstName: `Tf${RUN}`, lastName: `S${seq}`,
    roles: [role] as never[], activeRole: role as never, status: 'ACTIVE', isPhoneVerified: true, countryCode: 'GY',
  } }));
  users.push(u.id);
  return u.id;
}
async function pending(userId: string, docType: string, role: 'MOVER' | 'VENDOR_OWNER' = 'MOVER') {
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl: '', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
}
const approve = (docId: string, payload: Record<string, unknown>) => app.inject({
  method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, payload,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const statusOf = async (id: string) =>
  (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }))).status;
const keysOf = (accountId: string) =>
  system(() => app.prisma.identityKey.findMany({ where: { accountId }, select: { type: true, valueHash: true, source: true } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const a = await system(() => app.prisma.user.create({ data: {
    phone: `+59278${NUM}99`, firstName: 'Tf', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true,
    // `documents.review`: the explicit document reviewer grant (PR-V3); harmless where it is not yet demanded.
    admin: { create: { permissions: ['*', 'documents.review'] } },
  } }));
  users.push(a.id);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `tf-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
});

afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } }).catch(() => {});
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.documentRecord.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } }).catch(() => {});
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: users } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[typed fields] the ID or licence number', () => {
  it('a national ID is not approved until the reviewer types its number', async () => {
    const doc = await pending(await subject(), 'national_id');
    const res = await approve(doc.id, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DOCUMENT_NUMBER_REQUIRED');
    expect(await statusOf(doc.id)).toBe('PENDING');
  });

  it('the typed number becomes a HARD identity key as a blind index only — the number is stored and echoed nowhere', async () => {
    const who = await subject();
    const doc = await pending(who, 'national_id');
    const typed = `${NUM}-${RUN.slice(0, 3)}-77`;
    const res = await approve(doc.id, { documentNumber: typed });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(doc.id)).toBe('APPROVED');
    const normalized = typed.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    expect(await keysOf(who)).toContainEqual({ type: 'ID_DOC_NUMBER', valueHash: blind(normalized), source: 'REVIEWER_TYPED' });
    expect(res.body).not.toContain(typed);
    expect(res.body).not.toContain(normalized);
    const stored = JSON.stringify(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })));
    expect(stored).not.toContain(normalized);
    const audits = JSON.stringify(await system(() => app.prisma.auditLog.findMany({ where: { entityId: doc.id } })));
    expect(audits).not.toContain(normalized);
    expect(audits).not.toContain(typed);
  });

  it('two accounts presenting the same ID number become one identity (the trial-abuse check sees it)', async () => {
    const first = await subject();
    const second = await subject('VENDOR_OWNER');
    const number = `9${NUM}${RUN.slice(0, 2)}1`;
    expect((await approve((await pending(first, 'national_id')).id, { documentNumber: number })).statusCode).toBe(200);
    expect((await approve((await pending(second, 'owner_national_id', 'VENDOR_OWNER')).id, { documentNumber: ` ${number.slice(0, 3)} ${number.slice(3)} ` })).statusCode).toBe(200);
    const members = await system(() => clusterMemberIds(app.prisma, first));
    expect(members.sort()).toEqual([first, second].sort());
  });

  it('a driver’s licence needs its licence number; two accounts with one licence are one identity; a licence never matches an ID number', async () => {
    const first = await subject();
    const second = await subject();
    const third = await subject();
    const number = `L${NUM}${RUN.slice(0, 3)}`;
    const missing = await approve((await pending(first, 'drivers_licence')).id, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('DOCUMENT_NUMBER_REQUIRED');
    const expiresAt = new Date(Date.now() + 400 * DAY).toISOString();
    expect((await approve((await pending(first, 'drivers_licence')).id, { documentNumber: number, expiresAt })).statusCode).toBe(200);
    expect((await approve((await pending(second, 'drivers_licence')).id, { documentNumber: number.toLowerCase(), expiresAt })).statusCode).toBe(200);
    expect((await system(() => clusterMemberIds(app.prisma, first))).sort()).toEqual([first, second].sort());
    // the same characters typed from a national ID belong to another number space
    expect((await approve((await pending(third, 'national_id')).id, { documentNumber: number })).statusCode).toBe(200);
    expect(await system(() => clusterMemberIds(app.prisma, third))).not.toContain(first);
  });

  it('a number too short to identify anyone is refused', async () => {
    const doc = await pending(await subject(), 'national_id');
    const res = await approve(doc.id, { documentNumber: '1-2' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DOCUMENT_NUMBER_INVALID');
    expect(await statusOf(doc.id)).toBe('PENDING');
  });
});

describe('[typed fields] the police clearance issue date', () => {
  it('is required, kept on the record, and sets the re-check one year after issue', async () => {
    const who = await subject();
    const missing = await approve((await pending(who, 'police_clearance')).id, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('ISSUE_DATE_REQUIRED');
    const doc = await pending(who, 'police_clearance');
    const issuedOn = new Date(Date.now() - 60 * DAY);
    issuedOn.setUTCHours(0, 0, 0, 0);
    const res = await approve(doc.id, { issuedOn: issuedOn.toISOString().slice(0, 10) });
    expect(res.statusCode, res.body).toBe(200);
    const row = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }));
    expect(row.expiresAt?.toISOString()).toBe(new Date(issuedOn.getTime() + 365 * DAY).toISOString());
    const record = await system(() => app.prisma.documentRecord.findUniqueOrThrow({ where: { submissionId: doc.id } }));
    expect(record.issuedOn?.toISOString()).toBe(issuedOn.toISOString());
    expect(record.expiresOn?.toISOString()).toBe(row.expiresAt?.toISOString());
  });

  it('a clearance issued more than a year ago, or dated in the future, is refused', async () => {
    const who = await subject();
    const old = await approve((await pending(who, 'police_clearance')).id, { issuedOn: new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10) });
    expect(old.statusCode).toBe(400);
    expect(old.json().error.code).toBe('CLEARANCE_TOO_OLD');
    const future = await approve((await pending(who, 'police_clearance')).id, { issuedOn: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10) });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('ISSUE_DATE_IN_FUTURE');
  });
});

describe('[typed fields] nothing changes for a document that needs nothing typed', () => {
  it('a business registration approves with an empty body, as before', async () => {
    const doc = await pending(await subject('VENDOR_OWNER'), 'business_registration', 'VENDOR_OWNER');
    expect((await approve(doc.id, {})).statusCode).toBe(200);
    expect(await statusOf(doc.id)).toBe('APPROVED');
  });

  it('the queue tells the console what each document needs typed', async () => {
    const who = await subject();
    const id = await pending(who, 'national_id');
    const pc = await pending(who, 'police_clearance');
    const lic = await pending(who, 'drivers_licence');
    // the queue is oldest-first and shared with every other suite: page until ours are seen
    const rows: Array<{ id: string; reviewerTypes: string[] }> = [];
    for (let page = 1; page <= 200; page += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/queue?status=PENDING&limit=50&page=${page}`,
        headers: { authorization: `Bearer ${adminToken}` } });
      expect(res.statusCode).toBe(200);
      const batch = res.json().data as Array<{ id: string; reviewerTypes: string[] }>;
      rows.push(...batch);
      if (batch.length < 50 || [id.id, pc.id, lic.id].every((want) => rows.some((r) => r.id === want))) break;
    }
    expect(rows.find((r) => r.id === id.id)?.reviewerTypes).toEqual(['documentNumber']);
    expect(rows.find((r) => r.id === pc.id)?.reviewerTypes).toEqual(['issuedOn']);
    expect(rows.find((r) => r.id === lic.id)?.reviewerTypes).toEqual(['documentNumber']);
  });
});
