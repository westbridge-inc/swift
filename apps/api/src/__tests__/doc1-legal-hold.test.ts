/**
 * [DOC-1 §9.4 · P9-4] test_legal_hold_blocks_purge · test_legal_holds_have_owner_and_review_date
 *
 * A legal hold names one person, a reason, an accountable owner and a review
 * date, and stamps that person's unpurged documents. While stamped, a
 * document is skipped by the reaper and by account erasure (DOC-INV-14);
 * release clears the stamp and the purge clock resumes. A hold never
 * resurrects purged bytes. Holds are placed only through the admin endpoint,
 * by a C3 actor with a stated reason, and logged. Overdue holds alarm
 * (DOC-INV-32).
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
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { AccountService } from '../modules/user/account.service';
import { alertOverdueDocLegalHolds, placeDocLegalHold } from '../modules/verification/legal-hold';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const REASON = `Regulator request ${RUN}: preserve identity documents pending the enquiry`;
const DAY = 86_400_000;

let app: FastifyInstance;
let adminApp: FastifyInstance;
let adminToken = '';
let adminId = '';
let verification: VerificationService;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-legal-hold-test');

async function person(n: number, role: 'VENDOR_OWNER' | 'CUSTOMER' = 'VENDOR_OWNER') {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59273${NUM}${n}`, firstName: 'Held', lastName: `Person${n}`, activeRole: role, roles: [role === 'CUSTOMER' ? 'CUSTOMER' : role], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(u.id);
  return u.id;
}
/** A document whose bytes are gone from storage (fileUrl empty → NOTHING_STORED), due for purge yesterday unless told otherwise. */
const doc = (userId: string, extra: Record<string, unknown> = {}) => runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
  userId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: '', status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1',
  retentionExpiresAt: new Date(Date.now() - DAY), ...extra,
} }));
const place = (payload: Record<string, unknown>, headers: Record<string, string> = { 'x-swift-reason': REASON }) => adminApp.inject({
  method: 'POST', url: '/api/v1/admin/verification/legal-holds', payload,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', ...headers },
});
const release = (id: string) => adminApp.inject({
  method: 'PUT', url: `/api/v1/admin/verification/legal-holds/${id}/release`, payload: {},
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': `Enquiry closed ${RUN}, nothing further required` },
});
const docsOf = (userId: string) => system(() => app.prisma.verificationDocument.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.ready();
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59273${NUM}9`, firstName: 'Hold', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  adminId = admin.id; users.push(adminId);
  adminToken = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: admin.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `hold-admin-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    // deletion_receipt is append-only by design — the receipts stay.
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: adminId } });
    // audit_logs is append-only by design — the rows stay.
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: adminId } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await adminApp.close();
  await app.close();
});

describe('[DOC-1 P9-4] legal holds on document submissions', () => {
  it('placing a hold stamps only the unpurged, unheld documents of the person, names an owner and a review date, and is logged', async () => {
    const u = await person(1);
    const a = await doc(u); const b = await doc(u);
    const purged = await doc(u, { purgedAt: new Date(), fileUrl: '' });
    const res = await place({ subjectUserId: u, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(res.statusCode).toBe(201);
    const { hold, documents } = res.json().data;
    expect(documents).toBe(2);
    expect(hold).toMatchObject({ subjectUserId: u, ownerId: adminId, placedBy: adminId, reason: REASON, releasedAt: null, tenantId: 'swift-default' });
    const rows = await docsOf(u);
    const byId = new Map(rows.map((d) => [d.id, d.legalHoldId]));
    expect([byId.get(a.id), byId.get(b.id), byId.get(purged.id)]).toEqual([hold.id, hold.id, null]);
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'PLACE_DOC_LEGAL_HOLD', entityId: hold.id } }));
    expect(audit?.userId).toBe(adminId);
  });

  it('test_legal_hold_blocks_purge: the reaper skips held documents; released, they purge with a receipt on the next sweep', async () => {
    const u = await person(2);
    const a = await doc(u); const free = await doc(u);
    const res = await place({ subjectUserId: u, documentIds: [a.id], reviewBy: new Date(Date.now() + 10 * DAY).toISOString() });
    expect(res.statusCode).toBe(201);
    const holdId = res.json().data.hold.id as string;
    await verification.purgeExpiredDocuments();
    let rows = await docsOf(u);
    expect(rows.find((d) => d.id === a.id)!.purgedAt).toBeNull();     // held: untouched
    expect(rows.find((d) => d.id === free.id)!.purgedAt).not.toBeNull(); // not held: purged
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: a.id } }))).toBe(0);
    const rel = await release(holdId);
    expect(rel.statusCode).toBe(200);
    expect(rel.json().data.documents).toBe(1);
    expect((await docsOf(u)).find((d) => d.id === a.id)!.legalHoldId).toBeNull();
    await verification.purgeExpiredDocuments();
    rows = await docsOf(u);
    expect(rows.find((d) => d.id === a.id)!.purgedAt).not.toBeNull();
    expect(await system(() => app.prisma.deletionReceipt.count({ where: { submissionId: a.id } }))).toBe(1);
    expect((await release(holdId)).statusCode).toBe(409); // released twice is a lie
  });

  it('account erasure defers a held document — recorded, retention clock set to now — and purges the rest', async () => {
    const u = await person(3, 'CUSTOMER');
    const held = await doc(u, { role: 'CUSTOMER', docType: 'identity_l2', retentionExpiresAt: new Date(Date.now() + 400 * DAY) });
    const free = await doc(u, { role: 'CUSTOMER', docType: 'identity_l2', retentionExpiresAt: new Date(Date.now() + 400 * DAY) });
    await system(() => placeDocLegalHold(app.prisma, { subjectUserId: u, documentIds: [held.id], reason: REASON, ownerId: adminId, reviewBy: new Date(Date.now() + 5 * DAY), placedBy: adminId }));
    await runWithTenant('swift-default', () => new AccountService(app).deleteAccount(u));
    const rows = await docsOf(u);
    const h = rows.find((d) => d.id === held.id)!;
    const f = rows.find((d) => d.id === free.id)!;
    expect(h.purgedAt).toBeNull();
    expect(h.legalHoldId).not.toBeNull();
    expect(h.retentionExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(f.purgedAt).not.toBeNull();
    const deferred = await system(() => app.prisma.auditLog.findFirst({ where: { action: 'ERASURE_DEFERRED_LEGAL_HOLD', entityId: u } }));
    expect((deferred?.changes as { heldDocuments?: number })?.heldDocuments).toBe(1);
  });

  it('test_legal_holds_have_owner_and_review_date: no hold without a reason or a review date in window; the database refuses a review date not after placement; overdue holds alarm the admins', async () => {
    const u = await person(4);
    await doc(u, { retentionExpiresAt: new Date(Date.now() + 400 * DAY) });
    // Placing and releasing a hold are consequential: C3, a reason owed by class (ADM-006) — not only by the handler's own check.
    expect(ADMIN_ROUTE_AUTHORITY['POST /verification/legal-holds']?.cls).toBe('C3');
    expect(ADMIN_ROUTE_AUTHORITY['PUT /verification/legal-holds/:id/release']?.cls).toBe('C3');
    expect((await place({ subjectUserId: u, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() }, {})).statusCode).toBe(400); // ADM-006: no stated reason
    expect((await place({ subjectUserId: u })).statusCode).toBe(400); // no review date
    expect((await place({ subjectUserId: u, reviewBy: new Date(Date.now() - DAY).toISOString() })).json().error?.code ?? (await place({ subjectUserId: u, reviewBy: new Date(Date.now() - DAY).toISOString() })).statusCode).toBeTruthy();
    const past = await place({ subjectUserId: u, reviewBy: new Date(Date.now() - DAY).toISOString() });
    expect(past.statusCode).toBe(400);
    const far = await place({ subjectUserId: u, reviewBy: new Date(Date.now() + 400 * DAY).toISOString() });
    expect(far.statusCode).toBe(400);
    await expect(system(() => app.prisma.$executeRaw`
      INSERT INTO doc_legal_hold ("subjectUserId", reason, "ownerId", "reviewBy", "placedBy", "placedAt")
      VALUES (${u}, ${REASON}, ${adminId}, now(), ${adminId}, now())`)).rejects.toThrow(/doc_legal_hold_review_after_placed/);
    // A hold whose review date has passed (set directly: the endpoint refuses to create one) alarms every admin of the tenant.
    const ok = await place({ subjectUserId: u, reviewBy: new Date(Date.now() + 2 * DAY).toISOString() });
    expect(ok.statusCode).toBe(201);
    const holdId = ok.json().data.hold.id as string;
    // Age the hold: placement three days ago, review due yesterday (the CHECK keeps reviewBy after placedAt).
    await system(() => app.prisma.$executeRaw`UPDATE doc_legal_hold SET "placedAt" = now() - interval '3 days', "reviewBy" = now() - interval '1 day' WHERE id = ${holdId}::uuid`);
    const overdue = await alertOverdueDocLegalHolds(app.prisma, new NotificationService(app.prisma, app.io));
    expect(overdue).toBeGreaterThanOrEqual(1);
    const notes = await system(() => app.prisma.notification.findMany({ where: { userId: adminId } }));
    const mine = notes.filter((n) => (n.data as { kind?: string; holdIds?: string[] } | null)?.kind === 'verification_legal_hold_overdue' && ((n.data as { holdIds?: string[] }).holdIds ?? []).includes(holdId));
    expect(mine.length).toBeGreaterThanOrEqual(1);
  });

  it('a hold never resurrects purged bytes: with nothing left to hold it is refused', async () => {
    const u = await person(5);
    await doc(u, { purgedAt: new Date() });
    const res = await place({ subjectUserId: u, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('NOTHING_TO_HOLD');
  });
});
