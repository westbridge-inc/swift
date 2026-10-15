/**
 * [R24 · research C4 · owner rulings 6 Oct (6) and 15 Oct] KEEP PARTNER DOCUMENTS ONLY AS LONG AS NEEDED.
 *
 *  - A partner's PERSONAL image (ID, licence, police clearance, selfie) is purged 30 days after
 *    the decision on it. The record stays VALID and the partner stays verified. Business and
 *    vehicle images, anything under a legal hold, and a CUSTOMER's ID (kept while the account is
 *    open) are left alone. No registry type has to be switched on: the bucket decides.
 *  - A partner's REJECTED document gets a clock: 30 days after the rejection for a personal one,
 *    the registry window (90 days) for a vehicle or business one; never lengthened, never under a
 *    legal hold; the reaper deletes it when due.
 *  - Vehicle and business documents: kept while active + 90 days (was 7 years); the country
 *    default after leaving is 90 days (was 365).
 *
 * Continues VERIFY-DOCS PR-V2 (fix/verify-docs-retention), rebuilt on main's purge path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { PrismaClient, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { applyImagePolicy } from '../modules/verification/image-policy';
import {
  seedDocRegistry, registryCode, reconcileImagePolicy, PROVISIONAL_RETENTION_DAYS, LEGACY_PROVISIONAL_RETENTION_DAYS,
} from '../modules/verification/doc-registry';
import { documentRecordDdl } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';
import { CountryConfigService } from '../modules/country/country-config.service';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'partner-document-retention-test');
/** The sweep reads documents; in the shared test database it may only ever see this suite's. */
const scoped = (): PrismaClient => app.prisma.$extends({ query: { verificationDocument: { async findMany({ args, query }) {
  return query({ ...args, where: { AND: [args.where ?? {}, { userId: { in: [...users] } }] } });
} } } }) as unknown as PrismaClient;

async function person(role: UserRole) {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59277${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Keep', lastName: `Less${seq}`, activeRole: role, roles: [role],
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(role === 'CUSTOMER' ? { customer: { create: {} } } : {}),
  } }));
  users.push(u.id);
  return u.id;
}

async function stored(userId: string, docType: string) {
  const { getStorageProvider } = await import('../providers/storage/storage-provider');
  const bytes = Buffer.from(`image ${RUN} ${docType} ${nanoid(4)}`);
  const { url } = await getStorageProvider().upload({ buffer: bytes, filename: `${docType}-${nanoid(5)}.enc`, mimeType: 'application/octet-stream', folder: `verification/${userId}` });
  await app.prisma.encryptedObject.create({ data: {
    fileKey: url, createdBy: userId, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.alloc(60, 3),
    mimeType: 'image/jpeg', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  } });
  return url;
}

/** An approved (committed) submission with bytes in storage, decided `daysAgo` days ago. */
async function decided(userId: string, role: UserRole, docType: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  const fileUrl = await stored(userId, docType);
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl, status: 'APPROVED', reviewedBy: 'retention-test',
    reviewedAt: new Date(Date.now() - daysAgo * DAY), expiresAt: new Date(Date.now() + 300 * DAY), ...extra,
  } }));
}
async function rejected(userId: string, role: UserRole, docType: string, daysAgo: number) {
  const fileUrl = await stored(userId, docType);
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl, status: 'REJECTED', state: 'REJECTED', reviewedBy: 'retention-test',
    reviewedAt: new Date(Date.now() - daysAgo * DAY), reviewNote: 'unreadable',
  } }));
}
const docOf = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }));
const setDays = (key: string, value: number | null) => system(() => value === null
  ? app.prisma.platformConfig.deleteMany({ where: { key } })
  : app.prisma.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } }));
const holdOn = (userId: string) => system(() => app.prisma.docLegalHold.create({ data: {
  subjectUserId: userId, reason: `hold ${RUN}`, ownerId: userId, placedBy: userId, reviewBy: new Date(Date.now() + 30 * DAY),
} }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  service = new VerificationService(scoped(), new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
  await setDays('documents.personal_image_days', null);
  await setDays('documents.rejected_document_days', null);
});

afterAll(async () => {
  await setDays('documents.personal_image_days', null);
  await setDays('documents.rejected_document_days', null);
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[R24] a partner\'s personal image goes 30 days after the decision; the record stays', () => {
  it('purges it with no registry switch and no extraction, keeps the record VALID and the partner verified, with a probed receipt', async () => {
    const u = await person('VENDOR_OWNER');
    const doc = await decided(u, 'VENDOR_OWNER', 'owner_national_id', 31);
    const run = await system(() => applyImagePolicy(scoped(), service));
    expect(run.purged).toBe(1);
    const after = await docOf(doc.id);
    expect(after.imagePurgedAt).not.toBeNull();
    expect(after.fileUrl).toBe('');
    expect(after.purgedAt).toBeNull();
    expect((await system(() => app.prisma.documentRecord.findUniqueOrThrow({ where: { submissionId: doc.id } }))).status).toBe('VALID');
    expect(await system(() => service.isVerifiedForList(u, ['owner_national_id']))).toBe(true);
    const receipt = await system(() => app.prisma.deletionReceipt.findFirst({ where: { submissionId: doc.id } }));
    expect(receipt?.verificationProbeResult).toBe('CONFIRMED_ABSENT');
    expect(receipt?.deletedBy).toBe('partner-image-retention');
    // a second sweep finds nothing
    expect((await system(() => applyImagePolicy(scoped(), service))).purged).toBe(0);
  });

  it('every partner role, every personal type: a rider\'s licence, a driver\'s police clearance, a mover\'s selfie', async () => {
    const docs = [
      await decided(await person('RIDER'), 'RIDER', 'drivers_licence', 45),
      await decided(await person('DRIVER'), 'DRIVER', 'police_clearance', 31),
      await decided(await person('MOVER'), 'MOVER', 'selfie', 60),
    ];
    await system(() => applyImagePolicy(scoped(), service));
    for (const d of docs) expect((await docOf(d.id)).imagePurgedAt, d.docType).not.toBeNull();
  });

  it('leaves alone: a decision under 30 days old, business and vehicle images, a held document, and a CUSTOMER\'s ID', async () => {
    const young = await decided(await person('VENDOR_OWNER'), 'VENDOR_OWNER', 'national_id', 29);
    const business = await decided(await person('VENDOR_OWNER'), 'VENDOR_OWNER', 'business_registration', 90);
    const vehicle = await decided(await person('DRIVER'), 'DRIVER', 'vehicle_registration', 90);
    const h = await person('VENDOR_OWNER');
    const hold = await holdOn(h);
    const held = await decided(h, 'VENDOR_OWNER', 'national_id', 90, { legalHoldId: hold.id });
    const customerId = await decided(await person('CUSTOMER'), 'CUSTOMER', 'identity_l2', 400);
    await system(() => applyImagePolicy(scoped(), service));
    for (const d of [young, business, vehicle, held, customerId]) {
      const now = await docOf(d.id);
      expect(now.imagePurgedAt, `${d.role}/${d.docType}`).toBeNull();
      expect(now.fileUrl, `${d.role}/${d.docType}`).not.toBe('');
    }
  });

  it('the window is a setting: at 60 days a 40-day-old decision stays; a nonsense value falls back to 30', async () => {
    await setDays('documents.personal_image_days', 60);
    try {
      const d = await decided(await person('RIDER'), 'RIDER', 'drivers_licence', 40);
      await system(() => applyImagePolicy(scoped(), service));
      expect((await docOf(d.id)).imagePurgedAt).toBeNull();
      await setDays('documents.personal_image_days', 0);
      await system(() => applyImagePolicy(scoped(), service));
      expect((await docOf(d.id)).imagePurgedAt).not.toBeNull();
    } finally { await setDays('documents.personal_image_days', null); }
  });
});

describe('[R24] a partner\'s rejected document is deleted after its window', () => {
  it('personal: rejection + 30 days; vehicle/business: the registry window (90 days); the reaper deletes what is due', async () => {
    const u = await person('VENDOR_OWNER');
    const oldId = await rejected(u, 'VENDOR_OWNER', 'owner_national_id', 31);
    const recentId = await rejected(u, 'VENDOR_OWNER', 'national_id', 5);
    const business = await rejected(u, 'VENDOR_OWNER', 'business_registration', 31);
    await system(() => service.scheduleRejectedDocumentRetention());
    expect((await docOf(oldId.id)).retentionExpiresAt?.getTime()).toBe(oldId.reviewedAt!.getTime() + 30 * DAY);
    expect((await docOf(recentId.id)).retentionExpiresAt?.getTime()).toBe(recentId.reviewedAt!.getTime() + 30 * DAY);
    expect((await docOf(business.id)).retentionExpiresAt?.getTime()).toBe(business.reviewedAt!.getTime() + PROVISIONAL_RETENTION_DAYS * DAY);
    await system(() => service.purgeExpiredDocuments());
    expect((await docOf(oldId.id)).purgedAt).not.toBeNull();
    expect((await docOf(recentId.id)).purgedAt).toBeNull();
    expect((await docOf(business.id)).purgedAt).toBeNull();
  });

  it('a clock already sooner is never pushed later; a held document and a customer\'s document are never scheduled', async () => {
    const u = await person('RIDER');
    const soon = await rejected(u, 'RIDER', 'drivers_licence', 2);
    const sooner = new Date(Date.now() + 3 * DAY);
    await system(() => app.prisma.verificationDocument.update({ where: { id: soon.id }, data: { retentionExpiresAt: sooner } }));
    const h = await person('RIDER');
    const hold = await holdOn(h);
    const heldDoc = await rejected(h, 'RIDER', 'drivers_licence', 45);
    await system(() => app.prisma.verificationDocument.update({ where: { id: heldDoc.id }, data: { legalHoldId: hold.id } }));
    const customer = await rejected(await person('CUSTOMER'), 'CUSTOMER', 'identity_l2', 45);
    await system(() => service.scheduleRejectedDocumentRetention());
    expect((await docOf(soon.id)).retentionExpiresAt?.getTime()).toBe(sooner.getTime());
    expect((await docOf(heldDoc.id)).retentionExpiresAt).toBeNull();
    expect((await docOf(customer.id)).retentionExpiresAt).toBeNull();
  });
});

describe('[R24] vehicle and business documents: while active + 90 days', () => {
  it('the provisional window is 90 days, and a row still on the old 7-year window moves at the next reconcile', async () => {
    expect(PROVISIONAL_RETENTION_DAYS).toBe(90);
    const code = registryCode('GY', 'vehicle_registration');
    await system(() => app.prisma.docType.update({ where: { code }, data: { persistRetentionDays: LEGACY_PROVISIONAL_RETENTION_DAYS } }));
    await system(() => reconcileImagePolicy(app.prisma, 'GY'));
    expect((await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code } }))).persistRetentionDays).toBe(90);
    // a deliberately chosen window is left as it is
    await system(() => app.prisma.docType.update({ where: { code }, data: { persistRetentionDays: 120 } }));
    await system(() => reconcileImagePolicy(app.prisma, 'GY'));
    expect((await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code } }))).persistRetentionDays).toBe(120);
    await system(() => app.prisma.docType.update({ where: { code }, data: { persistRetentionDays: PROVISIONAL_RETENTION_DAYS } }));
  });

  it('the country default after a partner leaves is 90 days (was 365)', async () => {
    expect((await new CountryConfigService(app.prisma).getByCode('GY')).dataRetentionDays).toBe(90);
  });
});
