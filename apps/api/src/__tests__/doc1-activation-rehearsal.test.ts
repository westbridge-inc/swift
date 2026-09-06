/**
 * [DOC-1 §10.3/10.5 · P10-4] E2E-DOC-10, scaled to synthetic rows: the
 * activation rehearsal judges every verified actor against the checklist
 * they would face after activation with the one evidence rule, applies the
 * 90-day grandfather window, names the registry gaps and the routing
 * effects, and writes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { rehearseActivation, renderRehearsal, GRANDFATHER_DAYS } from '../modules/verification/activation-rehearsal';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-activation-rehearsal-test');

async function user(role: 'VENDOR_OWNER' | 'RIDER') {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59283${NUM}${seq}`, firstName: 'Rehearse', lastName: `Actor${seq}`, activeRole: role, roles: [role], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true } }));
  users.push(u.id); return u.id;
}
const doc = (userId: string, docType: string, extra: Record<string, unknown> = {}) => runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
  userId, role: 'VENDOR_OWNER', docType, fileUrl: `verification/${RUN}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'seed', reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1', ...extra,
} }));
async function verifiedStore(docTypes: string[], lapsed = false) {
  const ownerUserId = await user('VENDOR_OWNER');
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: ownerUserId } }));
  const vendor = await runWithTenant('swift-default', () => app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Rehearsal Store ${RUN}${seq}`, slug: `rehearsal-${RUN}-${seq}`, vendorType: 'STORE', phone: `+59284${NUM}${seq}`,
    addressLine1: '1 Rehearsal Row', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
  } }));
  vendorIds.push(vendor.id);
  for (const t of docTypes) await doc(ownerUserId, t, lapsed && t === 'tin_certificate' ? { expiresAt: new Date(Date.now() - DAY) } : {});
  return { ownerUserId, vendorId: vendor.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(socketPlugin);
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P10-4] the activation rehearsal', () => {
  it('E2E-DOC-10 (scaled): a verified store with its full checklist KEEPs; one already lapsed is named as such and not counted; the recheck date is activation + 90 days; nothing is written', async () => {
    const STORE = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
    const kept = await verifiedStore(STORE);
    const lapsed = await verifiedStore(STORE, true);
    const riderUserId = await user('RIDER');
    const rider = await runWithTenant('swift-default', () => app.prisma.rider.create({ data: { userId: riderUserId, riderType: 'DELIVERY', vehicleType: 'BICYCLE', documentsVerified: true } }));
    for (const t of ['national_id', 'police_clearance']) await doc(riderUserId, t);
    const activationDate = new Date();
    const activeBefore = await system(() => app.prisma.docType.count({ where: { isActive: true } }));
    const report = await system(() => rehearseActivation(app.prisma, service, { countryCode: 'GY', legacyCodes: 'ALL', activationDate }));
    expect(report.zeroSuspended).toBe(true);
    expect(report.actors.wouldSuspend).toBe(0);
    const byVendor = new Map(report.actors.verdicts.filter((v) => v.kind === 'VENDOR').map((v) => [v.actorId, v]));
    expect(byVendor.get(kept.vendorId)?.verdict).toBe('KEEP');
    expect(byVendor.get(lapsed.vendorId)?.verdict).toBe('ALREADY_LAPSED');
    expect(report.actors.verdicts.find((v) => v.kind === 'RIDER' && v.actorId === rider.id)?.verdict).toBe('KEEP');
    for (const v of report.actors.verdicts) expect(v.recheckBy.getTime()).toBe(activationDate.getTime() + GRANDFATHER_DAYS * DAY);
    expect(byVendor.get(kept.vendorId)?.checklistAfter).toEqual(STORE); // the registry set says the same as the JSON
    expect(report.registry.setsThatSwitch.find((s) => s.actorRole === 'STORE')).toMatchObject({ same: true });
    expect(report.registry.gaps.length).toBeGreaterThan(0); // UNPROFILED / NO_FIELDS / phantom validators — production would refuse to boot
    expect(report.registry.gaps.some((g) => g.docTypeCode === registryCode('GY', 'storefront_photo') && g.gap === 'NO_FIELDS')).toBe(true);
    expect(report.routing.alwaysReview).toEqual(expect.arrayContaining(['national_id', 'owner_national_id', 'police_clearance', 'vehicle_insurance']));
    expect(report.routing.noAutoApprovalUntilConfidence).toContain('business_registration');
    expect(report.images.find((i) => i.bucket === 'BUSINESS')?.stored).toBeGreaterThan(0);
    // nothing written: no type activated, no document touched
    expect(await system(() => app.prisma.docType.count({ where: { isActive: true } }))).toBe(activeBefore);
    expect((await system(() => app.prisma.verificationDocument.findMany({ where: { userId: kept.ownerUserId } }))).every((d) => d.status === 'APPROVED')).toBe(true);
    const text = renderRehearsal(report);
    expect(text).toContain('ZERO actors suspended');
    expect(text).toContain(`ALREADY_LAPSED`);
  });

  it('a candidate set that would change a switched checklist is reported as DIFFERS, and an actor whose evidence only holds today is GRANDFATHERED, never suspended', async () => {
    // Give the STORE requirement set one more type than the JSON lists (a registry edit the founder might make) and rehearse.
// The extra type must exist in the BASE registry seed (food_handler_cert does; the §18.1 extras land with P18-2).
    const set = await system(() => app.prisma.requirementSet.findFirstOrThrow({ where: { countryCode: 'GY', actorRole: 'STORE' } }));
    const extra = registryCode('GY', 'food_handler_cert');
    await system(() => app.prisma.requirementItem.create({ data: { requirementSetId: set.id, docTypeCode: extra, isBlocking: true, minCount: 1, sortOrder: 99 } }));
    try {
      const store = await verifiedStore(['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo']);
      const report = await system(() => rehearseActivation(app.prisma, service, { countryCode: 'GY', legacyCodes: 'ALL' }));
      expect(report.registry.setsThatSwitch.find((s) => s.actorRole === 'STORE')).toMatchObject({ same: false });
      const v = report.actors.verdicts.find((x) => x.actorId === store.vendorId)!;
      expect(v.checklistAfter).toContain('food_handler_cert');
      expect(v.evidenceValidToday).toBe(true);
      expect(v.evidenceValidAfter).toBe(false);
      expect(v.verdict).toBe('GRANDFATHERED');
      expect(report.zeroSuspended).toBe(true);
      expect(report.actors.grandfathered).toBeGreaterThanOrEqual(1);
    } finally {
      await system(() => app.prisma.requirementItem.deleteMany({ where: { requirementSetId: set.id, docTypeCode: extra } }));
    }
  });
});
