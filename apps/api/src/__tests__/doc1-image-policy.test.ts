/**
 * [DOC-1 §1.3 · P1-3] test_bucket_drives_image_policy
 *
 * The bucket decides what happens to the image: the registry seed gives every
 * provisional type its bucket's policy (PERSONAL → PURGE_AFTER_REVIEW with no retention
 * days, VEHICLE → PERSIST_REDACTED, BUSINESS → PERSIST) and never overrides a type whose
 * legal facts were verified. The daily sweep purges the image of a committed PERSONAL
 * document only when its type is ACTIVE and its extraction succeeded — the record and the
 * verification stay (E2E-DOC-5). Inactive types, unextracted, held, business and already-
 * purged documents are left alone; a second sweep finds nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode, IMAGE_POLICY_OF_BUCKET, reconcileImagePolicy } from '../modules/verification/doc-registry';
import { applyImagePolicy } from '../modules/verification/image-policy';
import { documentRecordDdl } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const PERSONAL = 'owner_national_id';   // PERSONAL bucket, on the RESTAURANT checklist
const BUSINESS = 'business_registration';

let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
const activated: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-image-policy-test');

async function owner(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59275${NUM}${n}`, firstName: 'Img', lastName: `Policy${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY',
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  return u.id;
}
/** A committed submission with bytes in storage (a real object, so the probe can confirm absence). */
async function committed(userId: string, docType: string, extra: Record<string, unknown> = {}) {
  const { getStorageProvider } = await import('../providers/storage/storage-provider');
  const { url } = await getStorageProvider().upload({ buffer: Buffer.from(`image ${RUN}`), filename: `${docType}-${nanoid(5)}.enc`, mimeType: 'application/octet-stream', folder: `verification/${RUN}` });
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role: 'VENDOR_OWNER', docType, fileUrl: url, status: 'APPROVED', reviewedBy: 'policy-test', reviewedAt: new Date(), expiresAt: new Date(Date.now() + 100 * DAY), ...extra,
  } }));
}
const extractedOk = (submissionId: string, outcome: 'OK' | 'PARTIAL' | 'FAILED' = 'OK') => system(() => app.prisma.extractionRun.create({ data: {
  submissionId, tenantId: 'swift-default', profileCode: 'TEST', engineName: 'test', engineVersion: '1', startedAt: new Date(), outcome,
} }));
const docOf = (id: string) => system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { imagePurgedAt: true, purgedAt: true, fileUrl: true, state: true } }));
const activate = async (legacyCode: string) => {
  const code = registryCode('GY', legacyCode);
  await system(() => app.prisma.docType.update({ where: { code }, data: { isActive: true, legalFactsVerifiedAt: new Date() } }));
  activated.push(code);
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  await system(async () => {
    if (activated.length) await app.prisma.docType.updateMany({ where: { code: { in: activated } }, data: { isActive: false, legalFactsVerifiedAt: null } });
    await app.prisma.verificationDocument.updateMany({ where: { userId: { in: users } }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P1-3] the bucket drives the image policy', () => {
  it('the seed gives every provisional GY type its bucket policy, a purge policy carries no retention days, and a legally-verified row is never overridden', async () => {
    // §1.3 pinned as literals — the map under test never grades itself
    expect(IMAGE_POLICY_OF_BUCKET).toEqual({ PERSONAL: 'PURGE_AFTER_REVIEW', BUSINESS: 'PERSIST', VEHICLE: 'PERSIST_REDACTED' });
    const rows = await system(() => app.prisma.docType.findMany({ where: { countryCode: 'GY', legalFactsVerifiedAt: null }, select: { code: true, bucket: true, imagePolicy: true, persistRetentionDays: true } }));
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.imagePolicy, r.code).toBe(IMAGE_POLICY_OF_BUCKET[r.bucket]);
      expect(r.persistRetentionDays === null, r.code).toBe(r.imagePolicy === 'PURGE_AFTER_REVIEW');
    }
    expect(rows.some((r) => r.bucket === 'PERSONAL') && rows.some((r) => r.bucket === 'BUSINESS') && rows.some((r) => r.bucket === 'VEHICLE')).toBe(true);
    // a row whose legal facts were verified keeps what they set
    const code = registryCode('GY', 'tin_certificate');
    await system(() => app.prisma.docType.update({ where: { code }, data: { legalFactsVerifiedAt: new Date(), imagePolicy: 'PERSIST_REDACTED', persistRetentionDays: 365 } }));
    activated.push(code);
    await system(() => reconcileImagePolicy(app.prisma, 'GY'));
    expect((await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code } }))).imagePolicy).toBe('PERSIST_REDACTED');
  });

  it('the sweep purges only a committed, extracted PERSONAL document of an ACTIVE type — record and verification stay; everything else is left alone; a second sweep finds nothing', async () => {
    // One person per scenario: a newer commit of the same type for the same person would SUPERSEDE the earlier one (P4-2).
    const u = await owner(1);
    const target = await committed(u, PERSONAL); await extractedOk(target.id);
    const business = await committed(u, BUSINESS); await extractedOk(business.id);
    const u2 = await owner(2); const unextracted = await committed(u2, PERSONAL);
    const u3 = await owner(3); const partial = await committed(u3, PERSONAL); await extractedOk(partial.id, 'PARTIAL');
    const u4 = await owner(4);
    const hold = await system(() => app.prisma.docLegalHold.create({ data: { subjectUserId: u4, reason: `hold ${RUN}`, ownerId: u4, placedBy: u4, reviewBy: new Date(Date.now() + 30 * DAY) } }));
    const held = await committed(u4, PERSONAL, { legalHoldId: hold.id }); await extractedOk(held.id);

    // inactive type: nothing happens
    const before = await system(() => applyImagePolicy(app.prisma, service));
    expect((await docOf(target.id)).imagePurgedAt).toBeNull();
    expect(before.purged).toBe(0);

    await activate(PERSONAL);
    const run = await system(() => applyImagePolicy(app.prisma, service));
    expect(run.purged).toBeGreaterThanOrEqual(1);
    expect(await docOf(target.id)).toMatchObject({ purgedAt: null, fileUrl: '', state: 'COMMITTED' });
    expect((await docOf(target.id)).imagePurgedAt).not.toBeNull();
    const receipt = await system(() => app.prisma.deletionReceipt.findFirst({ where: { submissionId: target.id } }));
    expect(receipt?.verificationProbeResult).toBe('CONFIRMED_ABSENT');
    expect((await system(() => app.prisma.documentRecord.findUniqueOrThrow({ where: { submissionId: target.id } }))).status).toBe('VALID');
    expect(await system(() => service.isVerifiedForList(u, [PERSONAL]))).toBe(true);
    for (const d of [unextracted, partial, business, held]) expect((await docOf(d.id)).imagePurgedAt, d.docType).toBeNull();

    const again = await system(() => applyImagePolicy(app.prisma, service));
    expect(again.purged).toBe(0);
  });
});
