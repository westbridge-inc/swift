/**
 * [DOC-1 §4.4 · P4-2 · E2E-DOC-5] The durable document record.
 *
 * A commit writes a VALID record (by the database, from the state machine); expiry,
 * revocation and a newer commit move it (EXPIRED / REVOKED / SUPERSEDED). Verification
 * reads records: an image purged under its bucket's policy — bytes gone, deletion
 * receipt CONFIRMED_ABSENT — still answers "is this actor verified?" (E2E-DOC-5), while the
 * retention purge, which retires the submission, ends it. The migration mirrors the
 * generator verbatim and carries the §10.3 grandfather (recheck 90 days out).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { documentRecordDdl, DOCUMENT_RECORD_BACKFILL_SQL } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { approvedEvidenceFor } from '../modules/verification/evidence';
import { isProviderVerified, providerChecklist } from '../modules/services/services.service';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Decision ${RUN}: reviewed against the checklist`;
const MIGRATION = join(__dirname, '..', '..', 'prisma', 'migrations', '20260906110000_document_record', 'migration.sql');

let app: FastifyInstance;
let adminApp: FastifyInstance;
let adminToken = '';
let adminId = '';
let service: VerificationService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-document-record-test');

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59279${NUM}${n}`, firstName: 'Rec', lastName: `Ord${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
const submit = (userId: string, docType: string) =>
  runWithTenant('swift-default', () => service.submitDocument(userId, 'RESTAURANT', docType, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
const admin = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown> = {}) => adminApp.inject({
  method, url: `/api/v1/admin${url}`, payload, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const recordOf = (submissionId: string) => system(() => app.prisma.documentRecord.findUnique({ where: { submissionId } }));
const docOf = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { state: true, status: true, fileUrl: true, imagePurgedAt: true, purgedAt: true, subjectId: true } }));
const checklistFor = async (userId: string) => (service as unknown as { checklistFor: (u: string, c: string, r: string) => Promise<string[]> }).checklistFor(userId, 'GY', 'RESTAURANT');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
  const a = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59279${NUM}0`, firstName: 'Rec', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  adminId = a.id; users.push(adminId);
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rec-admin-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close();
  await app.close();
});

describe('[DOC-1 P4-2] the record is kept by the database', () => {
  it('the migration mirrors the generator verbatim and carries the 90-day grandfather backfill', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const statement of documentRecordDdl()) expect(sql).toContain(statement);
    expect(sql).toContain(DOCUMENT_RECORD_BACKFILL_SQL);
    expect(DOCUMENT_RECORD_BACKFILL_SQL).toContain("interval '90 days'");
  });

  it('a decision commits → a VALID record naming the approver, the expiry, and the subject; a legacy APPROVED insert gets one too', async () => {
    const u = await owner(1);
    const doc = await submit(u, 'business_registration');
    expect(await recordOf(doc.id)).toBeNull(); // queued for a human: no record yet
    const res = await admin('PUT', `/verification/${doc.id}/approve`, { expiresAt: new Date(Date.now() + 100 * DAY).toISOString() });
    expect(res.statusCode).toBe(200);
    const rec = await recordOf(doc.id);
    expect(rec).toMatchObject({ status: 'VALID', accountId: u, docType: 'business_registration', approvedBy: adminId, subjectId: (await docOf(doc.id)).subjectId, tenantId: 'swift-default', recheckBy: null });
    expect(rec!.expiresOn!.getTime()).toBeGreaterThan(Date.now() + 99 * DAY);
    const legacy = await system(() => app.prisma.verificationDocument.create({ data: { userId: u, role: 'VENDOR_OWNER', docType: 'tin_certificate', fileUrl: `x/${RUN}/tin`, status: 'APPROVED', reviewedBy: 'legacy' } }));
    expect(await recordOf(legacy.id)).toMatchObject({ status: 'VALID', approvedBy: 'legacy', expiresOn: null });
  });

  it('E2E-DOC-5: the image purged under policy (receipt CONFIRMED_ABSENT) still answers "verified"; the retention purge ends it', async () => {
    const u = await owner(2);
    const checklist = await checklistFor(u);
    const ids: string[] = [];
    for (const t of checklist) {
      const d = await submit(u, t);
      expect((await admin('PUT', `/verification/${d.id}/approve`, { expiresAt: new Date(Date.now() + 100 * DAY).toISOString() })).statusCode).toBe(200);
      ids.push(d.id);
    }
    expect(await system(() => service.isRoleVerified(u, 'RESTAURANT'))).toBe(true);
    const personal = ids[checklist.indexOf('owner_national_id')]!;
    const outcome = await system(() => service.purgeImageAfterReview(personal, 'policy'));
    expect(outcome).toBe('PURGED');
    expect(await docOf(personal)).toMatchObject({ state: 'COMMITTED', status: 'APPROVED', fileUrl: '', purgedAt: null });
    expect((await docOf(personal)).imagePurgedAt).not.toBeNull();
    const receipt = await system(() => app.prisma.deletionReceipt.findFirst({ where: { submissionId: personal }, orderBy: { deletedAt: 'desc' } }));
    expect(receipt?.verificationProbeResult).toBe('CONFIRMED_ABSENT');
    expect(await recordOf(personal)).toMatchObject({ status: 'VALID' });
    expect(await system(() => service.isRoleVerified(u, 'RESTAURANT'))).toBe(true); // the record answers, not the image
    expect(await system(() => service.purgeImageAfterReview(personal, 'policy'))).toBe('NOT_PURGED'); // once
    // retiring the submission (erasure: retention NOT elapsed) ends its evidence — the purgedAt rule alone
    const doc = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: personal }, select: { id: true, userId: true, fileUrl: true, docType: true, user: { select: { tenantId: true } } } }));
    expect(await system(() => service.purgeDocumentNow(doc, u, { requireRetentionElapsed: false, shredFields: true }))).toBe('PURGED');
    expect((await docOf(personal)).purgedAt).not.toBeNull();
    expect(await system(() => service.isRoleVerified(u, 'RESTAURANT'))).toBe(false);
  });

  it('expiry, revocation and a newer commit move the record; the superseded submission leaves COMMITTED and readers still see APPROVED', async () => {
    const u = await owner(3);
    const first = await submit(u, 'business_registration');
    // inside the 30-day renewal window, so a renewal is accepted (a document valid beyond it cannot be resubmitted)
    expect((await admin('PUT', `/verification/${first.id}/approve`, { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() })).statusCode).toBe(200);
    expect((await recordOf(first.id))!.status).toBe('VALID');
    // renewal: the same type commits again → the older record and submission are SUPERSEDED
    const second = await submit(u, 'business_registration');
    expect((await admin('PUT', `/verification/${second.id}/approve`, { expiresAt: new Date(Date.now() + 400 * DAY).toISOString() })).statusCode).toBe(200);
    expect((await recordOf(second.id))!.status).toBe('VALID');
    expect((await recordOf(first.id))!.status).toBe('SUPERSEDED');
    expect(await docOf(first.id)).toMatchObject({ state: 'SUPERSEDED', status: 'APPROVED' });
    const evidence = await system(() => approvedEvidenceFor(app.prisma, u, ['business_registration'], new Date()));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 399 * DAY);
    // revoke the current one
    expect((await admin('PUT', `/verification/${second.id}/revoke`, { reason: 'Registrar struck the company off' })).statusCode).toBe(200);
    expect((await recordOf(second.id))!.status).toBe('REVOKED');
    expect(await system(() => approvedEvidenceFor(app.prisma, u, ['business_registration'], new Date()))).toHaveLength(0);
    // expiry through the sweep
    const third = await submit(u, 'business_registration');
    expect((await admin('PUT', `/verification/${third.id}/approve`, { expiresAt: new Date(Date.now() + 5 * DAY).toISOString() })).statusCode).toBe(200);
    await system(() => app.prisma.verificationDocument.update({ where: { id: third.id }, data: { expiresAt: new Date(Date.now() - DAY) } }));
    await system(() => service.expireLapsedDocuments());
    expect((await recordOf(third.id))!.status).toBe('EXPIRED');
  });

  it('the service-provider projection reads the same records: verified through records, still verified after the image purge, not after the retention purge', async () => {
    const u = await owner(4);
    await system(() => app.prisma.user.update({ where: { id: u }, data: { status: 'ACTIVE', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } }));
    await system(() => app.prisma.serviceProvider.create({ data: { userId: u, trade: 'plumber' } }));
    const checklist = await system(() => providerChecklist(app.prisma, u));
    expect(checklist.length).toBeGreaterThan(0);
    const ids: string[] = [];
    for (const t of checklist) {
      const d = await runWithTenant('swift-default', () => service.submitDocument(u, 'SERVICE_PROVIDER', t, `/uploads/verification/${RUN}/${nanoid(5)}.enc`, 'v1'));
      expect((await admin('PUT', `/verification/${d.id}/approve`, { expiresAt: new Date(Date.now() + 100 * DAY).toISOString() })).statusCode).toBe(200);
      ids.push(d.id);
    }
    expect(await system(() => isProviderVerified(app.prisma, u))).toBe(true);
    expect(await system(() => service.purgeImageAfterReview(ids[0]!, 'policy'))).toBe('PURGED');
    expect(await system(() => isProviderVerified(app.prisma, u))).toBe(true);
    await system(() => app.prisma.verificationDocument.update({ where: { id: ids[0]! }, data: { retentionExpiresAt: new Date(Date.now() - DAY) } }));
    const doc = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: ids[0]! }, select: { id: true, userId: true, fileUrl: true, docType: true, user: { select: { tenantId: true } } } }));
    expect(await system(() => service.purgeDocumentNow(doc, 'reaper', { requireRetentionElapsed: true, shredFields: true }))).toBe('PURGED');
    expect(await system(() => isProviderVerified(app.prisma, u))).toBe(false);
  });
});
