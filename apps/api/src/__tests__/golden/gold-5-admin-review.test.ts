import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import multipart from '@fastify/multipart';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerErrorHandler } from '../../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { verificationRoutes } from '../../modules/verification/verification.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { DOC_REVIEWER_CAPABILITIES, SUPPORT_OPERATOR_CAPABILITIES } from '../../modules/admin/admin-authority';
import { FRAUD_GENERIC_TEXT } from '../../modules/verification/verification.service';
import { resetKeyProviderForTests } from '../../providers/storage/envelope';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { clusterMemberIds } from '../../modules/integrity/identity.service';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';

// ---------------------------------------------------------------------------
// GOLD-5 · ADMIN-01 — partner document review, through the REAL mounted
// verification and admin routes as real sessions, with the REAL encrypted
// upload and the REAL decrypting render:
//
//   · UPLOAD → FETCH → ACK → DECISION: a partner uploads a document (stored
//     only as ciphertext) and submits it; it lands in the review queue; a
//     reviewer opens it through the audited view link and sees exactly the
//     bytes the partner sent; claims the case (a second reviewer cannot take
//     it); approves it with a stated reason; one decision, one closed case,
//     one audit record; a repeat is refused; one approval does not activate a
//     store whose checklist is incomplete
//   · RECUSAL: a reviewer cannot claim or decide their own document, nor one
//     whose subject shares an identity-graph node with them (the same
//     document bytes on both accounts) — refused server-side, nothing moved
//   · TWO-PERSON: a fraud-class verdict is suspicion, not a rejection: it
//     escalates to SECOND_REVIEW; the reviewer who raised it cannot confirm
//     it; a different reviewer's confirmation rejects it, opens the fraud
//     case, holds the evidence and blocks pending the founder — and the
//     partner hears only the generic message
//   · WRONG ROLE: a SUPPORT operator sees counts only; the partner, a
//     reasonless decision and another tenant's reviewer are refused
//
// The two reviewers hold the ADMIN default grant, as the pilot's operators
// do; the recusal reviewers carry the DOC_REVIEWER preset and the wrong-role
// operator the SUPPORT preset, exactly as scoped accounts are provisioned. The key service
// is a per-file test KEK; storage is a per-file temp directory. Fixture range:
// +5920354nnn (this file only; audited range-aware).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920354';
const FIXTURE = 'gold5-admin-review-fixture';
const TENANT_SLUG_PREFIX = 'gold5-review-';
const TENANT_B = `${TENANT_SLUG_PREFIX}${nanoid(6).toLowerCase()}`;
const REASON = { 'x-swift-reason': 'GOLD-5 golden journey: reviewing a partner document' };
const UPLOAD_DIR = mkdtempSync(path.join(os.tmpdir(), 'swift-gold5-review-'));
const DOC_TYPE = 'business_registration';

let app: FastifyInstance;
let seq = 0;
let windowStart: Date | null = null;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; phone: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; grant?: readonly string[]; firstName?: string } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone, firstName: opts.firstName ?? 'Gold5', lastName: `Review${seq}`, roles, activeRole,
      tenantId: opts.tenantId ?? 'swift-default', countryCode: 'GY',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.grant && { admin: { create: { permissions: [...opts.grant] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `gold5-review-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, phone };
}

/** A partner applying for a restaurant: the store exists, pending approval. */
async function makeApplicant(firstName: string) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', { firstName });
  const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: `${firstName}'s Kitchen`, slug: `gold5-review-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: owner.phone, addressLine1: '1 Golden Review Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.80131, longitude: -58.15512, status: 'PENDING_APPROVAL',
    },
  }));
  return { ...owner, vendorId: vendor.id };
}

/** A real PNG: magic bytes, then a body unique to this document. */
const documentBytes = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`gold5-review-${nanoid(12)}`), randomBytes(64)]);

function upload(actor: Actor, bytes: Buffer) {
  const boundary = `----gold5${nanoid(8)}`;
  return app.inject({
    method: 'POST',
    url: '/api/v1/verification/upload',
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="registration.png"\r\ncontent-type: image/png\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${actor.token}` },
  });
}

/** Upload through the real route, then submit through the real route. */
async function uploadAndSubmit(actor: Actor, bytes: Buffer) {
  const up = await upload(actor, bytes);
  expect(up.statusCode, up.body).toBe(200);
  const fileUrl = up.json().data.url as string;
  const submitted = await call('POST', '/api/v1/verification/documents', actor.token, { role: 'RESTAURANT', docType: DOC_TYPE, fileUrl, consent: true, privacyNoticeVersion: 'v1' });
  expect(submitted.statusCode, submitted.body).toBe(201);
  return { docId: submitted.json().data.id as string, fileUrl, duplicate: up.json().data.duplicate as boolean };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

function admin(options: InjectOptions & { token: string }) {
  const { token, headers, ...rest } = options;
  return app.inject({ ...rest, headers: { ...(headers as Record<string, string> | undefined), ...REASON, authorization: `Bearer ${token}` } });
}

/** The case id as a reviewer finds it: in the document's custody narrative. */
async function openCaseOf(reviewer: Actor, docId: string): Promise<{ caseId: string; queue: string; assignedTo: string | null }> {
  const custody = await admin({ method: 'GET', url: `/api/v1/admin/verification/${docId}/custody`, token: reviewer.token });
  expect(custody.statusCode, custody.body).toBe(200);
  const open = (custody.json().data.review as Array<{ caseId: string; queue: string; assignedTo: string | null; closedAt: string | null }>).filter((c) => c.closedAt === null);
  expect(open).toHaveLength(1);
  return open[0]!;
}

const docRow = (id: string) => sys(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }));
const caseRow = (id: string) => sys(() => app.prisma.reviewCase.findUniqueOrThrow({ where: { id }, include: { decisions: { orderBy: { decidedAt: 'asc' } } } }));

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
      const cases = (await app.prisma.reviewCase.findMany({ where: { submissionId: { in: docs } }, select: { id: true } })).map((c) => c.id);
      const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
      const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
      const members = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: ids } }, select: { clusterId: true } });
      await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...docs, ...cases, ...vendorIds] } }] }, 'test-cleanup:gold-5-admin-review fixtures');
      await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: ids } }, { subjectId: { in: docs } }] }, 'test-cleanup:gold-5-admin-review fixture reads');
      await app.prisma.fraudCase.deleteMany({ where: { OR: [{ subjectUserId: { in: ids } }, { submissionId: { in: docs } }] } });
      await app.prisma.verificationDocument.updateMany({ where: { id: { in: docs } }, data: { legalHoldId: null } });
      await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: ids } } });
      await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.reviewDecision.deleteMany({ where: { caseId: { in: cases } } });
      await app.prisma.reviewCase.deleteMany({ where: { id: { in: cases } } });
      await app.prisma.verificationDocument.deleteMany({ where: { id: { in: docs } } });
      await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: ids } } });
      await app.prisma.identityKey.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: ids } } });
      // A merge leaves the absorbed cluster behind, member-less and pointing at
      // the survivor: remove the whole chain these accounts' clusters formed.
      let chain = [...new Set(members.map((m) => m.clusterId))];
      for (let hop = 0; hop < 8 && chain.length > 0; hop += 1) {
        const absorbed = await app.prisma.identityCluster.findMany({ where: { mergedIntoId: { in: chain }, id: { notIn: chain } }, select: { id: true } });
        if (absorbed.length === 0) break;
        chain = [...chain, ...absorbed.map((c) => c.id)];
      }
      if (chain.length > 0) {
        const stillUsed = await app.prisma.identityClusterMember.count({ where: { clusterId: { in: chain } } });
        if (stillUsed === 0) {
          await app.prisma.identityCluster.updateMany({ where: { id: { in: chain } }, data: { mergedIntoId: null } });
          await app.prisma.identityCluster.deleteMany({ where: { id: { in: chain } } });
        }
      }
      if (docs.length > 0) {
        await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'docId' IN (${Prisma.join(docs)}) OR "data"->>'documentId' IN (${Prisma.join(docs)}) OR "data"->>'submissionId' IN (${Prisma.join(docs)})`;
      }
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'uploader' IN (${Prisma.join(ids)}) OR "data"->>'accountId' IN (${Prisma.join(ids)}) OR "data"->>'userId' IN (${Prisma.join(ids)})`;
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await app.prisma.tenant.deleteMany({ where: { slug: { startsWith: TENANT_SLUG_PREFIX } } });
  });
}

/** Admin audit and sensitive-read rows are written in onResponse hooks, which
 *  can land just after a response resolves: sweep them once more by the ids
 *  this file created, after a moment, so the last request cannot outrun the
 *  purge. */
async function sweepLateAuditRows(ids: string[], reason: string) {
  if (ids.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sys(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] }, reason);
    await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: ids } }, { subjectId: { in: ids } }] }, reason);
  });
}

async function fixtureIds(): Promise<string[]> {
  return sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const cases = await app.prisma.reviewCase.findMany({ where: { submissionId: { in: docs.map((d) => d.id) } }, select: { id: true } });
    return [...ids, ...docs.map((d) => d.id), ...cases.map((c) => c.id)];
  });
}

let redisKeysBefore = new Set<string>();
async function allRedisKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const k of batch) keys.add(k);
  } while (cursor !== '0');
  return keys;
}

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', randomBytes(32).toString('base64'));
  vi.stubEnv('UPLOAD_DIR', UPLOAD_DIR);
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purgeFixtures();
  const dbNow = (await app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0]!.now;
  windowStart = new Date(Math.min(dbNow.getTime(), Date.now()) - 2_000);
  redisKeysBefore = await allRedisKeys();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Gold5 Review Tenant B', slug: TENANT_B } }));
}, 60_000);

afterAll(async () => {
  const owned = await fixtureIds();
  await purgeFixtures();
  await sweepLateAuditRows(owned, 'test-cleanup:gold-5-review late audit rows');
  if (windowStart) {
    await sys(() => app.prisma.alertDelivery.deleteMany({ where: { kind: 'ADMIN_OPS', subjectId: { in: ['verification_pending', 'dup_doc', 'doc_review', 'ops'] }, sentAt: { gte: windowStart! } } }));
  }
  const now = await allRedisKeys();
  const added = [...now].filter((k) => !redisKeysBefore.has(k));
  if (added.length > 0) await app.redis.del(...added);
  await app.close();
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  rmSync(UPLOAD_DIR, { recursive: true, force: true });
}, 60_000);

describe('GOLD-5 · ADMIN-01 — partner document review', () => {
  let rev1: Actor;
  let rev2: Actor;
  let support: Actor;
  let revB: Actor;
  let partner: Awaited<ReturnType<typeof makeApplicant>>;
  let bytes = Buffer.alloc(0);
  let docId = '';
  let caseId = '';

  beforeAll(async () => {
    // The pilot's operators hold the ADMIN default grant; the narrower
    // presets appear where their limits are the point.
    rev1 = await makeUser(['ADMIN'], 'ADMIN', { grant: ['*'], firstName: 'Rhea' });
    rev2 = await makeUser(['ADMIN'], 'ADMIN', { grant: ['*'], firstName: 'Ravi' });
    support = await makeUser(['ADMIN'], 'ADMIN', { grant: SUPPORT_OPERATOR_CAPABILITIES, firstName: 'Suki' });
    revB = await makeUser(['ADMIN'], 'ADMIN', { grant: DOC_REVIEWER_CAPABILITIES, tenantId: TENANT_B, firstName: 'Bram' });
    partner = await makeApplicant('Priya');
  }, 60_000);

  it('UPLOAD → FETCH → ACK → DECISION: the reviewer sees exactly the partner’s bytes, claims the case, and one approval closes it', async () => {
    const status = await call('GET', '/api/v1/verification/status?role=RESTAURANT', partner.token);
    expect(status.statusCode, status.body).toBe(200);
    const checklist = status.json().data.checklist as string[];
    expect(checklist).toContain(DOC_TYPE);
    expect(checklist.length).toBeGreaterThan(1); // one approval cannot complete it
    expect(status.json().data).toMatchObject({ missing: checklist, roleVerified: false });
    bytes = documentBytes();
    const submitted = await uploadAndSubmit(partner, bytes);
    docId = submitted.docId;
    expect(submitted.duplicate).toBe(false);

    // At rest: ciphertext only; the envelope records the true type and size.
    const envelope = await sys(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: submitted.fileUrl } }));
    expect({ mime: envelope.mimeType, size: envelope.sizeBytes, by: envelope.createdBy, sealed: envelope.wrappedDek !== null }).toEqual({ mime: 'image/png', size: bytes.length, by: partner.userId, sealed: true });
    const stored = await getStorageProvider().getObject(submitted.fileUrl);
    expect(stored.equals(bytes)).toBe(false);
    expect(stored.includes(bytes.subarray(8, 30))).toBe(false);

    const doc = await docRow(docId);
    expect({ status: doc.status, type: doc.docType, role: doc.role, reviewedBy: doc.reviewedBy }).toEqual({ status: 'PENDING', type: DOC_TYPE, role: 'VENDOR_OWNER', reviewedBy: null });
    // The review team is told; another tenant's reviewer is not.
    const paged = await sys(() => app.prisma.notification.findMany({ where: { userId: { in: [rev1.userId, rev2.userId, revB.userId] }, data: { path: ['docId'], equals: docId } } }));
    expect(paged.map((n) => ({ to: n.userId, title: n.title, kind: (n.data as Record<string, unknown>)['kind'] })).sort((a, b) => a.to.localeCompare(b.to)))
      .toEqual([rev1.userId, rev2.userId].sort().map((to) => ({ to, title: 'Verification review needed', kind: 'verification_pending' })));

    // FETCH: the queue lists it; the audited view link returns exactly the partner's bytes.
    const queue = await admin({ method: 'GET', url: '/api/v1/admin/verification/queue?status=PENDING', token: rev1.token });
    expect(queue.statusCode, queue.body).toBe(200);
    const listed = (queue.json().data as Array<{ id: string; user: { id: string } }>).find((d) => d.id === docId);
    expect(listed?.user.id).toBe(partner.userId);
    const link = await admin({ method: 'GET', url: `/api/v1/admin/verification/${docId}/document-url`, token: rev1.token });
    expect(link.statusCode, link.body).toBe(200);
    const url = link.json().data.url as string;
    expect(url.startsWith(`/api/v1/verification/render/${docId}?expires=`)).toBe(true);
    expect(link.json().data.expiresInSeconds).toBe(300);
    const shown = await app.inject({ method: 'GET', url });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toContain('image/png');
    expect(shown.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(shown.rawPayload).equals(bytes)).toBe(true);
    // The link is bound to its document: the same signature cannot open another.
    const forged = await app.inject({ method: 'GET', url: url.replace(docId, `${docId.slice(0, -1)}x`) });
    expect(forged.statusCode).toBe(403);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: docId, action: 'VIEW_VERIFICATION_DOC', userId: rev1.userId } }))).toBe(1);

    // ACK: the reviewer claims the case; a second reviewer cannot take it over.
    const found = await openCaseOf(rev1, docId);
    caseId = found.caseId;
    expect({ queue: found.queue, assignedTo: found.assignedTo }).toEqual({ queue: 'STANDARD', assignedTo: null });
    const claim = await admin({ method: 'POST', url: `/api/v1/admin/verification/cases/${caseId}/claim`, token: rev1.token, payload: {} });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json().data.assignedTo).toBe(rev1.userId);
    expect((await docRow(docId)).state).toBe('IN_REVIEW');
    const taken = await admin({ method: 'POST', url: `/api/v1/admin/verification/cases/${caseId}/claim`, token: rev2.token, payload: {} });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('CASE_CLAIMED');
    expect((await caseRow(caseId)).assignedTo).toBe(rev1.userId);

    // DECISION: approved, with a stated reason, once.
    const decideAt = Date.now();
    const approved = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, token: rev1.token, payload: {} });
    expect(approved.statusCode, approved.body).toBe(200);
    const decided = await docRow(docId);
    expect({ status: decided.status, state: decided.state, by: decided.reviewedBy }).toEqual({ status: 'APPROVED', state: 'COMMITTED', by: rev1.userId });
    const closed = await caseRow(caseId);
    expect(closed.closedAt!.getTime()).toBeGreaterThanOrEqual(decideAt - 1_000);
    expect(closed.closedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(closed.decisions.map((d) => ({ by: d.reviewerId, outcome: d.outcome }))).toEqual([{ by: rev1.userId, outcome: 'APPROVE' }]);
    const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: docId, action: 'APPROVE_VERIFICATION_DOC' } }));
    expect(trail.map((t) => t.userId)).toEqual([rev1.userId]);
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: partner.userId, title: 'Document approved' } }));
    expect(told.map((n) => (n.data as Record<string, unknown>)['docId'])).toEqual([docId]);

    // A repeat is refused and changes nothing; one document does not open the store.
    const again = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, token: rev2.token, payload: {} });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('NOT_PENDING');
    expect((await docRow(docId)).reviewedBy).toBe(rev1.userId);
    expect((await caseRow(caseId)).decisions).toHaveLength(1);
    const after = await call('GET', '/api/v1/verification/status?role=RESTAURANT', partner.token);
    expect(after.statusCode).toBe(200);
    expect(after.json().data).toMatchObject({ missing: checklist.filter((t) => t !== DOC_TYPE), roleVerified: false });
    expect((await sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: partner.vendorId } }))).status).toBe('PENDING_APPROVAL');
  });

  it('WRONG ROLE: a SUPPORT operator sees counts only; the applicant, a reasonless decision and another tenant’s reviewer are refused', async () => {
    const applicant = await makeApplicant('Wendell');
    const pendingCount = async () => {
      const counts = await admin({ method: 'GET', url: '/api/v1/admin/verification/queue/counts', token: support.token });
      expect(counts.statusCode, counts.body).toBe(200);
      return (counts.json().data.byStatus['PENDING'] as number | undefined) ?? 0;
    };
    const before = await pendingCount();
    const second = await uploadAndSubmit(applicant, documentBytes());
    const target = second.docId;
    // SUPPORT sees the queue move by exactly this document — as a number.
    expect(await pendingCount()).toBe(before + 1);
    for (const [method, url] of [
      ['GET', '/api/v1/admin/verification/queue?status=PENDING'],
      ['GET', `/api/v1/admin/verification/${target}/document-url`],
      ['GET', `/api/v1/admin/verification/${target}/custody`],
      ['PUT', `/api/v1/admin/verification/${target}/approve`],
    ] as const) {
      const res = await admin({ method, url, token: support.token, ...(method === 'PUT' ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // The applicant cannot review their own paperwork through the admin surface.
    expect((await call('PUT', `/api/v1/admin/verification/${target}/approve`, applicant.token, { reason: 'Approving my own business registration' })).statusCode).toBe(403);
    // A decision needs a stated reason.
    const bare = await app.inject({ method: 'PUT', url: `/api/v1/admin/verification/${target}/approve`, payload: {}, headers: { authorization: `Bearer ${rev1.token}`, 'content-type': 'application/json' } });
    expect(bare.statusCode).toBe(400);
    // Another tenant's reviewer neither sees it nor reaches it.
    const queueB = await admin({ method: 'GET', url: '/api/v1/admin/verification/queue?status=PENDING', token: revB.token });
    expect(queueB.statusCode).toBe(200);
    expect((queueB.json().data as Array<{ id: string }>).map((d) => d.id)).not.toContain(target);
    expect((await admin({ method: 'GET', url: `/api/v1/admin/verification/${target}/document-url`, token: revB.token })).statusCode).toBe(404);
    expect((await admin({ method: 'PUT', url: `/api/v1/admin/verification/${target}/approve`, token: revB.token, payload: {} })).statusCode).toBe(404);
    const untouched = await docRow(target);
    expect({ status: untouched.status, by: untouched.reviewedBy }).toEqual({ status: 'PENDING', by: null });
    const kase = await openCaseOf(rev1, target);
    expect(kase.assignedTo).toBeNull();
    expect((await caseRow(kase.caseId)).decisions).toHaveLength(0);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: target, action: 'VIEW_VERIFICATION_DOC' } }))).toBe(0);
  });

  it('RECUSAL: a reviewer cannot claim or decide their own document, nor one whose subject shares an identity node with them', async () => {
    // Their own: a reviewer who is also applying for a store.
    const moonlighter = await makeUser(['ADMIN', 'VENDOR_OWNER', 'CUSTOMER'], 'ADMIN', { grant: DOC_REVIEWER_CAPABILITIES, firstName: 'Mona' });
    const own = await uploadAndSubmit(moonlighter, documentBytes());
    const ownCase = await openCaseOf(rev1, own.docId);
    const selfClaim = await admin({ method: 'POST', url: `/api/v1/admin/verification/cases/${ownCase.caseId}/claim`, token: moonlighter.token, payload: {} });
    expect(selfClaim.statusCode).toBe(403);
    expect(selfClaim.json().error.code).toBe('REVIEWER_RECUSED');
    const selfApprove = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${own.docId}/approve`, token: moonlighter.token, payload: {} });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().error.code).toBe('REVIEWER_RECUSED');
    expect({ status: (await docRow(own.docId)).status, assigned: (await caseRow(ownCase.caseId)).assignedTo, decisions: (await caseRow(ownCase.caseId)).decisions.length })
      .toEqual({ status: 'PENDING', assigned: null, decisions: 0 });

    // Linked: a reviewer whose own paperwork is byte-identical to an applicant's
    // (the same registration on two accounts — one identity-graph node).
    const relative = await makeUser(['ADMIN', 'VENDOR_OWNER', 'CUSTOMER'], 'ADMIN', { grant: DOC_REVIEWER_CAPABILITIES, firstName: 'Lionel' });
    const applicant = await makeApplicant('Lorna');
    const shared = documentBytes();
    const first = await upload(relative, shared);
    expect(first.statusCode, first.body).toBe(200);
    const linked = await uploadAndSubmit(applicant, shared);
    expect(linked.duplicate).toBe(true);
    const linkedCase = await openCaseOf(rev1, linked.docId);
    expect(linkedCase.queue).toBe('SECOND_REVIEW'); // a collision is never an ordinary review
    // One identity, as the resolver recusal itself uses sees it.
    expect((await sys(() => clusterMemberIds(app.prisma, relative.userId))).sort()).toEqual([relative.userId, applicant.userId].sort());

    const linkedClaim = await admin({ method: 'POST', url: `/api/v1/admin/verification/cases/${linkedCase.caseId}/claim`, token: relative.token, payload: {} });
    expect(linkedClaim.statusCode).toBe(403);
    expect(linkedClaim.json().error.code).toBe('REVIEWER_RECUSED');
    const linkedApprove = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${linked.docId}/approve`, token: relative.token, payload: {} });
    expect(linkedApprove.statusCode).toBe(403);
    expect(linkedApprove.json().error.code).toBe('REVIEWER_RECUSED');
    expect({ status: (await docRow(linked.docId)).status, assigned: (await caseRow(linkedCase.caseId)).assignedTo, decisions: (await caseRow(linkedCase.caseId)).decisions.length })
      .toEqual({ status: 'PENDING', assigned: null, decisions: 0 });
    // An unrelated reviewer is not recused (control).
    const fair = await admin({ method: 'POST', url: `/api/v1/admin/verification/cases/${linkedCase.caseId}/claim`, token: rev2.token, payload: {} });
    expect(fair.statusCode, fair.body).toBe(200);
  });

  it('TWO-PERSON: a fraud verdict escalates; the reviewer who raised it cannot confirm it; a second reviewer confirms, and the evidence is held', async () => {
    const suspect = await makeApplicant('Silas');
    const doc = await uploadAndSubmit(suspect, documentBytes());
    const kase = await openCaseOf(rev1, doc.docId);
    expect((await admin({ method: 'POST', url: `/api/v1/admin/verification/cases/${kase.caseId}/claim`, token: rev1.token, payload: {} })).statusCode).toBe(200);

    // The first reviewer's fraud-class verdict is suspicion: the document stays pending.
    const raised = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${doc.docId}/reject`, token: rev1.token, payload: { reason: 'The registration seal does not match the registry format', reasonCode: 'SUSPECTED_TAMPERING' } });
    expect(raised.statusCode, raised.body).toBe(200);
    expect(raised.json().data.status).toBe('PENDING');
    let open = await caseRow(kase.caseId);
    expect({ queue: open.queue, assigned: open.assignedTo, closed: open.closedAt, decisions: open.decisions.map((d) => [d.reviewerId, d.outcome, d.reasonCode]) })
      .toEqual({ queue: 'SECOND_REVIEW', assigned: null, closed: null, decisions: [[rev1.userId, 'ESCALATE', 'SUSPECTED_TAMPERING']] });
    expect((await docRow(doc.docId)).status).toBe('PENDING');
    expect(await sys(() => app.prisma.fraudCase.count({ where: { submissionId: doc.docId } }))).toBe(0);
    expect(await sys(() => app.prisma.auditLog.count({ where: { entityId: doc.docId, action: 'ESCALATE_VERIFICATION_DOC', userId: rev1.userId } }))).toBe(1);

    // The same reviewer cannot be the second person.
    const selfConfirm = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${doc.docId}/reject`, token: rev1.token, payload: { reason: 'Confirming my own suspicion of tampering', reasonCode: 'SUSPECTED_TAMPERING' } });
    expect(selfConfirm.statusCode).toBe(403);
    expect(selfConfirm.json().error.code).toBe('SECOND_REVIEWER_REQUIRED');
    open = await caseRow(kase.caseId);
    expect({ status: (await docRow(doc.docId)).status, decisions: open.decisions.length, closed: open.closedAt }).toEqual({ status: 'PENDING', decisions: 1, closed: null });

    // A different reviewer confirms: rejected, fraud case opened, evidence held, founder decides.
    const confirmAt = Date.now();
    const confirmed = await admin({ method: 'PUT', url: `/api/v1/admin/verification/${doc.docId}/reject`, token: rev2.token, payload: { reason: 'Confirmed: the seal was altered', reasonCode: 'SUSPECTED_TAMPERING' } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const rejected = await docRow(doc.docId);
    expect({ status: rejected.status, by: rejected.reviewedBy }).toEqual({ status: 'REJECTED', by: rev2.userId });
    const hold = await sys(() => app.prisma.docLegalHold.findUniqueOrThrow({ where: { id: rejected.legalHoldId! } }));
    expect({ subject: hold.subjectUserId, placedBy: hold.placedBy, released: hold.releasedAt }).toEqual({ subject: suspect.userId, placedBy: rev2.userId, released: null });
    expect(hold.reason).toBe('Fraud confirmed on second review (SUSPECTED_TAMPERING) — evidence preserved for a founder decision');
    const closed = await caseRow(kase.caseId);
    expect(closed.closedAt!.getTime()).toBeGreaterThanOrEqual(confirmAt - 1_000);
    expect(closed.closedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(closed.decisions.map((d) => [d.reviewerId, d.outcome])).toEqual([[rev1.userId, 'ESCALATE'], [rev2.userId, 'REJECT']]);
    const fraud = await sys(() => app.prisma.fraudCase.findMany({ where: { submissionId: doc.docId } }));
    expect(fraud.map((f) => ({ subject: f.subjectUserId, by: f.confirmedBy, code: f.reasonCode, hold: f.legalHoldId }))).toEqual([{ subject: suspect.userId, by: rev2.userId, code: 'SUSPECTED_TAMPERING', hold: rejected.legalHoldId }]);
    const block = await sys(() => app.prisma.enforcementAction.findMany({ where: { accountId: suspect.userId } }));
    expect(block.map((b) => ({ level: b.level, by: b.decidedBy }))).toEqual([{ level: 'BLOCK_PENDING_FOUNDER', by: rev2.userId }]);
    // The partner hears the generic message — never which signal caught them.
    const told = await sys(() => app.prisma.notification.findMany({ where: { userId: suspect.userId, title: 'Document rejected' } }));
    expect(told.map((n) => n.body)).toEqual([`Your business registration was rejected: ${FRAUD_GENERIC_TEXT}. Please fix it and resubmit.`]);
    expect(told[0]!.body.toLowerCase()).not.toMatch(/seal|tamper|altered/);
  });
});
