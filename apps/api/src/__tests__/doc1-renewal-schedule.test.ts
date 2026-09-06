/**
 * [DOC-1 §9.3 · P4-7] test_expiry_always_scheduled — DOC-INV-4.
 *
 * Every APPROVED document with an expiry has a renewal schedule, kept by the
 * database: notices at T-30 / T-14 / T-7 / T-1, suspension at expiry. The
 * sweep sends at most one notice per document per run — the latest due — and
 * advances lastNotified so a gap never becomes a burst; expiry marks the
 * schedule suspended.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { installDdl } from './helpers/install-ddl';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { renewalScheduleDdl, noticeTimesFor, dueRenewalNotices, RENEWAL_NOTICE_DAYS } from '../modules/verification/renewal-schedule';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
let ownerId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-renewal-schedule-test');
const scheduleOf = (documentId: string) => system(() => app.prisma.renewalSchedule.findUnique({ where: { documentId } }));
const notices = (docId: string) => system(() => app.prisma.notification.findMany({ where: { userId: ownerId }, orderBy: { createdAt: 'asc' } })).then((rows) => rows.filter((n) => (n.data as { kind?: string; docId?: string } | null)?.kind === 'verification_expiry_reminder' && (n.data as { docId?: string }).docId === docId));
const pending = (docType: string, fileUrl = `verification/${RUN}/${docType}-${nanoid(4)}.enc`) => runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: { userId: ownerId, role: 'VENDOR_OWNER', docType, fileUrl, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  await installDdl(app.prisma, renewalScheduleDdl()); // the DDL under test is the TS source of truth
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59282${NUM}1`, firstName: 'Renew', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true } }));
  const owner = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59282${NUM}2`, firstName: 'Renew', lastName: `Owner${RUN}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true } }));
  adminId = admin.id; ownerId = owner.id;
});

afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: ownerId }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: ownerId } }); // schedules cascade
    await app.prisma.notification.deleteMany({ where: { userId: { in: [ownerId, adminId] } } });
    await app.prisma.user.deleteMany({ where: { id: { in: [ownerId, adminId] } } });
  });
  await app.close();
});

describe('[DOC-1 P4-7] renewal schedules the database keeps', () => {
  it('approving a document with a printed expiry creates its schedule: four notices at T-30/14/7/1 and suspension at expiry; a document without an expiry has none', async () => {
    const doc = await pending('food_handler_cert');
    const expiresAt = new Date(Date.now() + 200 * DAY);
    await runWithTenant('swift-default', () => service.approveDocument(doc.id, adminId, expiresAt));
    const s = await scheduleOf(doc.id);
    expect(s).not.toBeNull();
    expect(s!.expiresOn.getTime()).toBe(expiresAt.getTime());
    expect(s!.suspendAt.getTime()).toBe(expiresAt.getTime());
    expect(s!.notifyAt.map((t) => Math.round((expiresAt.getTime() - t.getTime()) / DAY))).toEqual([...RENEWAL_NOTICE_DAYS]);
    expect(s!.notifyAt.map((t) => t.getTime())).toEqual(noticeTimesFor(expiresAt).map((t) => t.getTime()));
    expect([s!.subjectId, s!.tenantId, s!.lastNotified, s!.suspendedAt]).toEqual([ownerId, 'swift-default', null, null]);
    const plain = await pending('storefront_photo');
    await runWithTenant('swift-default', () => service.approveDocument(plain.id, adminId));
    expect(await scheduleOf(plain.id)).toBeNull();
  });

  it('test_expiry_always_scheduled: the database keeps it — a row written straight into the table gets its schedule, and no approved document with an expiry lacks one', async () => {
    const direct = await runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
      userId: ownerId, role: 'VENDOR_OWNER', docType: 'gra_restaurant_licence', fileUrl: `verification/${RUN}/direct.enc`, status: 'APPROVED', reviewedBy: 'seed', reviewedAt: new Date(),
      consentAt: new Date(), privacyNoticeVersion: 'v1', expiresAt: new Date(Date.now() + 100 * DAY),
    } }));
    expect(await scheduleOf(direct.id)).not.toBeNull();
    const unscheduled = await system(() => app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM verification_documents d
      WHERE d.status = 'APPROVED' AND d."expiresAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM renewal_schedule r WHERE r."documentId" = d.id)`);
    expect(Number(unscheduled[0]!.n)).toBe(0);
    // a changed expiry re-plans the notices and forgets what was sent for the old date
    await system(() => app.prisma.renewalSchedule.update({ where: { documentId: direct.id }, data: { lastNotified: new Date() } }));
    const later = new Date(Date.now() + 150 * DAY);
    await system(() => app.prisma.verificationDocument.update({ where: { id: direct.id }, data: { expiresAt: later } }));
    const replanned = await scheduleOf(direct.id);
    expect(replanned!.expiresOn.getTime()).toBe(later.getTime());
    expect(replanned!.lastNotified).toBeNull();
  });

  it('the sweep sends at most one notice per document per run — the latest due — and advances lastNotified; a gap never becomes a burst', async () => {
    const doc = await pending('tin_certificate');
    const expiresAt = new Date(Date.now() + 20 * DAY); // T-30 has passed, T-14 has not
    await runWithTenant('swift-default', () => service.approveDocument(doc.id, adminId, expiresAt));
    expect(await service.sendExpiryReminders()).toBeGreaterThanOrEqual(1);
    let sent = await notices(doc.id);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.data as { daysLeft?: number }).daysLeft).toBe(30);
    expect(await service.sendExpiryReminders()).toBe(0); // nothing new is due
    expect(await notices(doc.id)).toHaveLength(1);
    // Simulate the sweep having been silent across both T-14 and T-7: exactly ONE notice, the T-7.
    const sixDaysOut = new Date(Date.now() + 6 * DAY);
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { expiresAt: sixDaysOut } }));
    await system(() => app.prisma.renewalSchedule.update({ where: { documentId: doc.id }, data: { lastNotified: new Date(sixDaysOut.getTime() - 30 * DAY) } }));
    const due = await dueRenewalNotices(app.prisma);
    expect(due.filter((d) => d.documentId === doc.id).map((d) => d.daysLeft)).toEqual([7]);
    await service.sendExpiryReminders();
    sent = await notices(doc.id);
    expect(sent).toHaveLength(2);
    expect((sent[1]!.data as { daysLeft?: number }).daysLeft).toBe(7);
    expect((await scheduleOf(doc.id))!.lastNotified!.getTime()).toBe(sixDaysOut.getTime() - 7 * DAY);
  });

  it('expiry marks the schedule suspended in the same transaction as the status change', async () => {
    const doc = await pending('police_clearance');
    await runWithTenant('swift-default', () => service.approveDocument(doc.id, adminId, new Date(Date.now() + 5 * DAY)));
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() - DAY) } }));
    await service.expireLapsedDocuments();
    const row = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }));
    expect(row.status).toBe('EXPIRED');
    expect((await scheduleOf(doc.id))!.suspendedAt).toBeInstanceOf(Date);
  });
});
