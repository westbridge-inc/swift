/**
 * [DOC-1 Part V · P5-1] The document state machine — §5.2's five illegal transitions,
 * named as the spec names them, refused by the DATABASE:
 *   test_no_approval_without_validation · test_blocking_fail_never_auto_approves ·
 *   test_purged_is_terminal · test_legal_hold_blocks_purge · test_commit_requires_provenance
 * plus: the transition table in the database is exactly `DOC_TRANSITIONS` and the
 * migration mirrors the generator; legacy `status` writes derive a state and face the
 * same checks (no bypass); a submission walks CAPTURED → … → REVIEW_QUEUED through the
 * real path; claim / release / approve (implicit claim) / revoke move the state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocState } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { DOC_STATES, DOC_TRANSITIONS, DOC_STATE_MIGRATION_HEADER, LEGACY_STATUS_OF, docStateMachineDdl, isTransitionAllowed } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const REASON = `Decision ${RUN}: the document was reviewed against the checklist`;
const MIGRATION = join(__dirname, '..', '..', 'prisma', 'migrations', '20260906090000_doc_state_machine', 'migration.sql');

let app: FastifyInstance;
let adminApp: FastifyInstance;
let adminToken = '';
let adminId = '';
let service: VerificationService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-state-machine-test');

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59278${NUM}${n}`, firstName: 'State', lastName: `Machine${n}`, activeRole: 'VENDOR_OWNER', countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
/** A row a LEGACY writer would insert (status only) or a row planted at a machine state (state only). */
const plant = (userId: string, data: Record<string, unknown>) => runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
  userId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: `/uploads/verification/${RUN}/${nanoid(5)}.enc`,
  consentAt: new Date(), privacyNoticeVersion: 'v1', ...data,
} }));
const at = (userId: string, state: DocState, extra: Record<string, unknown> = {}) => plant(userId, { state, ...extra });
const move = (id: string, state: DocState) => system(() => app.prisma.$executeRawUnsafe('UPDATE verification_documents SET state = $1::"DocState" WHERE id = $2', state, id));
const setStatus = (id: string, status: string) => system(() => app.prisma.$executeRawUnsafe('UPDATE verification_documents SET status = $1::"VerificationDocumentStatus" WHERE id = $2', status, id));
const read = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { state: true, status: true, purgedAt: true, reviewNote: true } }));
const submit = (userId: string, url = `/uploads/verification/${RUN}/${nanoid(5)}.enc`) =>
  runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', 'business_registration', url, 'v1'));
const decideApprove = (docId: string, reviewerId: string, outcome: 'APPROVE' | 'REJECT' = 'APPROVE') => system(async () => {
  const kase = await app.prisma.reviewCase.create({ data: { submissionId: docId, tenantId: 'swift-default', queue: 'STANDARD', slaDueAt: new Date() } });
  await app.prisma.reviewDecision.create({ data: { caseId: kase.id, tenantId: 'swift-default', reviewerId, outcome, reasonCode: outcome === 'APPROVE' ? 'APPROVED' : 'UNSPECIFIED', actorFacingCategory: outcome === 'APPROVE' ? 'APPROVED' : 'OTHER' } });
});
const admin = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown> = {}) => adminApp.inject({
  method, url: `/api/v1/admin${url}`, payload,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.ready();
  await installDdl(app.prisma, docStateMachineDdl());
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
  const a = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59279${NUM}0`, firstName: 'State', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  adminId = a.id; users.push(adminId);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `sm-admin-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close();
  await app.close();
});

describe('[DOC-1 P5-1] the transition table is ONE table', () => {
  it('the database rows are exactly DOC_TRANSITIONS, LEGAL_HOLD is never a stored state, and the migration mirrors the generator verbatim', async () => {
    const rows = await system(() => app.prisma.docStateTransition.findMany());
    const key = (t: { fromState: string; toState: string; event: string }) => `${t.fromState}>${t.toState}:${t.event}`;
    expect(new Set(rows.map(key))).toEqual(new Set(DOC_TRANSITIONS.map((t) => key({ fromState: t.from, toState: t.to, event: t.event }))));
    expect(rows).toHaveLength(DOC_TRANSITIONS.length);
    expect(DOC_STATES).toHaveLength(17);
    expect(DOC_TRANSITIONS.some((t) => t.from === 'LEGAL_HOLD' || t.to === 'LEGAL_HOLD')).toBe(false);
    expect(DOC_TRANSITIONS.some((t) => t.from === 'PURGED')).toBe(false);
    // The spec's named rows are present …
    for (const [from, to] of [['CAPTURED', 'PREPROCESSED'], ['EXTRACTED', 'VALIDATED'], ['VALIDATED', 'AUTO_APPROVED'], ['REVIEW_QUEUED', 'IN_REVIEW'], ['IN_REVIEW', 'APPROVED'], ['APPROVED', 'COMMITTED'], ['COMMITTED', 'EXPIRED'], ['COMMITTED', 'REVOKED'], ['REJECTED', 'PURGED']] as const) {
      expect(isTransitionAllowed(from, to)).toBe(true);
    }
    // … and §5.2's illegal pairs are absent.
    expect(isTransitionAllowed('EXTRACTED', 'APPROVED')).toBe(false);
    expect(isTransitionAllowed('REVIEW_QUEUED', 'APPROVED')).toBe(false);
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql.startsWith(DOC_STATE_MIGRATION_HEADER)).toBe(true);
    for (const statement of docStateMachineDdl()) expect(sql).toContain(statement);
  });

  it('a legacy insert (status only) derives its state; a planted state projects its legacy status', async () => {
    const u = await owner(1);
    const approved = await plant(u, { status: 'APPROVED' });
    const pending = await plant(u, {});
    const rejected = await plant(u, { status: 'REJECTED' });
    const purged = await plant(u, { status: 'APPROVED', purgedAt: new Date(), fileUrl: '' });
    expect((await read(approved.id)).state).toBe('COMMITTED');
    expect((await read(pending.id)).state).toBe('REVIEW_QUEUED');
    expect((await read(rejected.id)).state).toBe('REJECTED');
    expect(await read(purged.id)).toMatchObject({ state: 'PURGED', status: 'APPROVED' });
    for (const state of DOC_STATES.filter((s) => s !== 'LEGAL_HOLD')) {
      const row = await at(u, state, state === 'PURGED' ? { purgedAt: new Date(), fileUrl: '' } : {});
      expect((await read(row.id)).status).toBe(LEGACY_STATUS_OF[state] ?? 'PENDING');
    }
    await expect(at(u, 'LEGAL_HOLD')).rejects.toThrow(/DOC_STATE_ILLEGAL: LEGAL_HOLD is an overlay/);
  });
});

describe('[DOC-1 §5.2] the five illegal transitions are refused by the database', () => {
  it('test_no_approval_without_validation — EXTRACTED → APPROVED is refused, by state or by legacy status; validation first is the only way', async () => {
    const u = await owner(2);
    const d = await at(u, 'EXTRACTED');
    await expect(move(d.id, 'APPROVED')).rejects.toThrow(/DOC_STATE_ILLEGAL: EXTRACTED -> APPROVED/);
    await expect(setStatus(d.id, 'APPROVED')).rejects.toThrow(/DOC_STATE_ILLEGAL: EXTRACTED -> APPROVED/);
    await expect(move(d.id, 'COMMITTED')).rejects.toThrow(/DOC_STATE_ILLEGAL/);
    expect(await read(d.id)).toMatchObject({ state: 'EXTRACTED', status: 'PENDING' });
    await move(d.id, 'VALIDATED');
    await move(d.id, 'REVIEW_QUEUED');
    expect(await read(d.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING' });
  });

  it('test_blocking_fail_never_auto_approves — VALIDATED → AUTO_APPROVED is refused while any blocking validator FAILed; a WARN does not block', async () => {
    const u = await owner(3);
    const failed = await at(u, 'VALIDATED');
    const warned = await at(u, 'VALIDATED');
    await system(() => app.prisma.validationResult.createMany({ data: [
      { submissionId: failed.id, tenantId: 'swift-default', validatorCode: 'V_TEST_BLOCKING', status: 'FAIL', isBlocking: true },
      { submissionId: warned.id, tenantId: 'swift-default', validatorCode: 'V_TEST_WARN', status: 'WARN', isBlocking: false },
    ] }));
    await expect(move(failed.id, 'AUTO_APPROVED')).rejects.toThrow(/DOC_STATE_ILLEGAL: AUTO_APPROVED with a blocking FAIL/);
    await move(failed.id, 'REVIEW_QUEUED'); // T9: a human
    await move(warned.id, 'AUTO_APPROVED');
    expect(await read(warned.id)).toMatchObject({ state: 'AUTO_APPROVED', status: 'APPROVED' });
  });

  it('test_purged_is_terminal — nothing leaves PURGED', async () => {
    const u = await owner(4);
    const d = await at(u, 'PURGED', { purgedAt: new Date(), fileUrl: '' });
    for (const to of ['COMMITTED', 'REVIEW_QUEUED', 'CAPTURED', 'EXPIRED'] as const) {
      await expect(move(d.id, to)).rejects.toThrow(/DOC_STATE_ILLEGAL: PURGED -> /);
    }
    expect((await read(d.id)).state).toBe('PURGED');
  });

  it('test_legal_hold_blocks_purge — a held document cannot reach PURGED by state or by purgedAt; released, it can', async () => {
    const u = await owner(5);
    const hold = await system(() => app.prisma.docLegalHold.create({ data: { subjectUserId: u, reason: `Enquiry ${RUN}`, ownerId: adminId, placedBy: adminId, reviewBy: new Date(Date.now() + 30 * 86_400_000) } }));
    const d = await at(u, 'COMMITTED', { legalHoldId: hold.id });
    await expect(move(d.id, 'PURGED')).rejects.toThrow(/DOC_STATE_ILLEGAL: PURGED under a legal hold/);
    await expect(system(() => app.prisma.verificationDocument.update({ where: { id: d.id }, data: { purgedAt: new Date(), fileUrl: '' } }))).rejects.toThrow(/DOC_STATE_ILLEGAL: PURGED under a legal hold/);
    expect(await read(d.id)).toMatchObject({ state: 'COMMITTED', purgedAt: null });
    await system(() => app.prisma.verificationDocument.update({ where: { id: d.id }, data: { legalHoldId: null } }));
    await system(() => app.prisma.verificationDocument.update({ where: { id: d.id }, data: { purgedAt: new Date(), fileUrl: '' } }));
    expect(await read(d.id)).toMatchObject({ state: 'PURGED', status: 'APPROVED' });
  });

  it('test_commit_requires_provenance — COMMITTED needs an APPROVE decision on the document\'s case, or the AUTO_APPROVED ledger', async () => {
    const u = await owner(6);
    const bare = await at(u, 'APPROVED');
    await expect(move(bare.id, 'COMMITTED')).rejects.toThrow(/DOC_STATE_ILLEGAL: COMMITTED without provenance/);
    const rejectedOnly = await at(u, 'APPROVED');
    await decideApprove(rejectedOnly.id, adminId, 'REJECT');
    await expect(move(rejectedOnly.id, 'COMMITTED')).rejects.toThrow(/DOC_STATE_ILLEGAL: COMMITTED without provenance/);
    await decideApprove(bare.id, adminId);
    await move(bare.id, 'COMMITTED');
    expect(await read(bare.id)).toMatchObject({ state: 'COMMITTED', status: 'APPROVED' });
    const auto = await at(u, 'AUTO_APPROVED');
    await expect(move(auto.id, 'COMMITTED')).rejects.toThrow(/DOC_STATE_ILLEGAL: COMMITTED without provenance/);
    await system(() => app.prisma.extractionRun.create({ data: { submissionId: auto.id, tenantId: 'swift-default', profileCode: 'TEST', engineName: 'test', engineVersion: '1', startedAt: new Date(), outcome: 'OK' } }));
    await move(auto.id, 'COMMITTED');
    expect((await read(auto.id)).state).toBe('COMMITTED');
  });

  it('a legacy status write is not a bypass: it derives the state and faces the same checks', async () => {
    const u = await owner(7);
    const queued = await at(u, 'REVIEW_QUEUED');
    await expect(setStatus(queued.id, 'APPROVED')).rejects.toThrow(/DOC_STATE_ILLEGAL: REVIEW_QUEUED -> APPROVED/);
    const claimed = await at(u, 'IN_REVIEW');
    await expect(setStatus(claimed.id, 'APPROVED')).rejects.toThrow(/DOC_STATE_ILLEGAL: COMMITTED without provenance/);
    await decideApprove(claimed.id, adminId);
    await setStatus(claimed.id, 'APPROVED');
    expect(await read(claimed.id)).toMatchObject({ state: 'COMMITTED', status: 'APPROVED' });
    await setStatus(claimed.id, 'EXPIRED');
    expect((await read(claimed.id)).state).toBe('EXPIRED');
  });
});

describe('[DOC-1 §5.1] the real path walks the machine', () => {
  it('submit → REVIEW_QUEUED with an open case; claim → IN_REVIEW; release → REVIEW_QUEUED; approve without a claim passes through IN_REVIEW and commits with its decision; revoke withdraws it', async () => {
    const u = await owner(8);
    const doc = await submit(u);
    expect(await read(doc.id)).toMatchObject({ state: 'REVIEW_QUEUED', status: 'PENDING' });
    const kase = await system(() => app.prisma.reviewCase.findFirstOrThrow({ where: { submissionId: doc.id, closedAt: null } }));
    expect((await admin('POST', `/verification/cases/${kase.id}/claim`)).statusCode).toBe(200);
    expect((await read(doc.id)).state).toBe('IN_REVIEW');
    expect((await admin('POST', `/verification/cases/${kase.id}/release`)).statusCode).toBe(200);
    expect((await read(doc.id)).state).toBe('REVIEW_QUEUED');

    const approve = await admin('PUT', `/verification/${doc.id}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(await read(doc.id)).toMatchObject({ state: 'COMMITTED', status: 'APPROVED' });
    const decisions = await system(() => app.prisma.reviewDecision.findMany({ where: { case: { submissionId: doc.id } } }));
    expect(decisions.map((d) => d.outcome)).toEqual(['APPROVE']);

    const revoke = await admin('PUT', `/verification/${doc.id}/revoke`, { reason: 'Issuer confirmed the registration number was withdrawn' });
    expect(revoke.statusCode).toBe(200);
    expect(await read(doc.id)).toMatchObject({ state: 'REVOKED', status: 'REJECTED', reviewNote: 'REVOKED: Issuer confirmed the registration number was withdrawn' });
    const trail = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'REVOKE_VERIFICATION_DOC', entityId: doc.id } }));
    expect(trail).not.toBeNull();
    const again = await admin('PUT', `/verification/${doc.id}/revoke`, { reason: 'twice' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('NOT_COMMITTED');
  });

  it('the processor\'s verdict is reached by transitions: an auto-reject lands REJECTED; an approval without confidence never auto-commits', async () => {
    const u = await owner(9);
    const rejected = await submit(u, `/uploads/verification/${RUN}/auto-reject-${nanoid(4)}.enc`);
    expect(await read(rejected.id)).toMatchObject({ state: 'REJECTED', status: 'REJECTED' });
    const approved = await submit(u, `/uploads/verification/${RUN}/auto-approve-${nanoid(4)}.enc`);
    // While the registry type is INACTIVE the processor's approval stands (P6-4's confidence
    // gate engages at activation): T8 then T17, with the extraction ledger as the provenance.
    expect(await read(approved.id)).toMatchObject({ state: 'COMMITTED', status: 'APPROVED' });
    expect(await system(() => app.prisma.extractionRun.count({ where: { submissionId: approved.id } }))).toBe(1);
  });
});
