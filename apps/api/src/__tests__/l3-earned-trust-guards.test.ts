/**
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b), Q2 · COORD security review] L3 is earned from L1 directly (L2, which
 * needed a customer ID, is retired). Earning it must never be a way around a check:
 *
 *  - It never raises a rider's cash float by itself: the float stays at L1 until the rider's own partner documents
 *    were approved by a person, whatever the customer trust level. Twenty self-placed paid orders buy no float.
 *  - Strikes count across the person's linked accounts (the identity cluster), as they do for the restriction; an
 *    identity under review is not promoted.
 *  - An account whose trust a person withdrew (a person's REJECT of its customer ID, or any REVOKED decision on its
 *    documents) is never promoted automatically, nor is one under an integrity hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { CashRulesService } from '../modules/cash/cash-rules.service';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { FloatService } from '../modules/dispatch/float.service';

let app: FastifyInstance;
let cash: CashRulesService;
const users: string[] = [];
const clusters: string[] = [];
const base = 592_049_000_000 + Math.floor(Math.random() * 8_000_000);
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'l3-earned-trust-guards-test');
const DAY = 86_400_000;
const ioStub = { to: () => ({ emit: () => undefined }), emit: () => undefined } as never;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, ioStub), new OrderService(app.prisma, ioStub));
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.strike.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusters } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

/** An L1 account, 45 days old, with `paid` delivered and paid orders: the earned rule is met (20, 30 days, no strikes). */
async function earner(opts: { rider?: boolean; paid?: number } = {}) {
  seq += 1;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+${base + seq}`, firstName: 'Synthetic', lastName: `Earner${seq}`, roles: opts.rider ? ['CUSTOMER', 'RIDER'] : ['CUSTOMER'],
    activeRole: 'CUSTOMER', isPhoneVerified: true, countryCode: 'GY', trustLevel: 'L1', createdAt: new Date(Date.now() - 45 * DAY),
  } }));
  users.push(u.id);
  for (let i = 0; i < (opts.paid ?? 20); i++) {
    await system(() => app.prisma.order.create({ data: {
      orderNumber: `L3G-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: u.id, status: 'DELIVERED', paymentStatus: 'CAPTURED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
    } }));
  }
  if (opts.rider) {
    await system(() => app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } }));
  }
  return u.id;
}

const trust = async (id: string) => (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { trustLevel: true } }))).trustLevel;
const floatOf = async (id: string) => Number((await system(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: id }, select: { floatLimit: true } }))).floatLimit);
const floats = () => system(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { floatL1: true, floatL3: true } }));

/** A committed partner document of the rider's; `byPerson` adds the reviewer's APPROVE decision. */
async function partnerDoc(userId: string, docType: string, byPerson: boolean) {
  const doc = await system(() => app.prisma.verificationDocument.create({ data: {
    userId, role: 'MOVER', docType, fileUrl: `verification/${userId}/${nanoid(8)}.enc`, status: 'APPROVED', reviewedBy: byPerson ? 'fixture-reviewer' : 'kyc:auto', reviewedAt: new Date(),
    consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
  if (byPerson) {
    const tenantId = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } }))).tenantId;
    const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, tenantId, queue: 'STANDARD', slaDueAt: new Date(), closedAt: new Date() } }));
    await system(() => app.prisma.reviewDecision.create({ data: { caseId: kase.id, tenantId, reviewerId: 'fixture-reviewer', outcome: 'APPROVE', reasonCode: 'APPROVED', actorFacingCategory: 'APPROVED', timeOnCaseMs: 0 } }));
  }
  return doc;
}

describe('[CHECKLIST-LEGAL Q2] L3 never raises a rider\'s float by itself', () => {
  it('a rider who earns L3 on self-placed orders, with documents no person approved, fronts no more than L1', async () => {
    const id = await earner({ rider: true });
    await partnerDoc(id, 'drivers_licence', false);
    expect(await system(() => cash.maybePromoteToL3(id, 'GY'))).toBe(true);
    expect(await trust(id)).toBe('L3');
    expect(await floatOf(id)).toBe(Number((await floats()).floatL1));
  });

  it('once a person approved the rider\'s partner documents, an earned L3 sizes the float', async () => {
    const id = await earner({ rider: true });
    await partnerDoc(id, 'drivers_licence', true);
    await partnerDoc(id, 'vehicle_registration', true);
    expect(await system(() => cash.maybePromoteToL3(id, 'GY'))).toBe(true);
    expect(await floatOf(id)).toBe(Number((await floats()).floatL3));
    // one partner document approved by no person keeps the float at L1
    await partnerDoc(id, 'vehicle_insurance', false);
    await system(() => new FloatService(app.prisma).recomputeForUser(id));
    expect(await floatOf(id)).toBe(Number((await floats()).floatL1));
  });
});

describe('[CHECKLIST-LEGAL Q2] the earned rule is not a way around strikes or a person\'s decision', () => {
  it('a linked account\'s strike blocks the promotion (strikes follow the person, as for the restriction)', async () => {
    const id = await earner();
    const other = await earner({ paid: 0 });
    const cluster = await system(() => app.prisma.identityCluster.create({ data: {} }));
    clusters.push(cluster.id);
    await system(() => app.prisma.identityClusterMember.createMany({ data: [
      { accountId: id, clusterId: cluster.id, linkedVia: [] }, { accountId: other, clusterId: cluster.id, linkedVia: [] },
    ] }));
    await system(() => app.prisma.strike.create({ data: { userId: other, reason: 'failed_payment_no_show', phone: 'x', addressKey: 'geo:l3g' } }));
    expect(await system(() => cash.maybePromoteToL3(id, 'GY'))).toBe(false);
    expect(await trust(id)).toBe('L1');
  });

  it('an account whose customer ID a person withdrew, or rejected, is never promoted automatically', async () => {
    for (const reasonCode of ['REVOKED', 'UNREADABLE']) {
      const id = await earner();
      const tenantId = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { tenantId: true } }))).tenantId;
      const doc = await system(() => app.prisma.verificationDocument.create({ data: {
        userId: id, role: 'CUSTOMER', docType: 'identity_l2', fileUrl: '', status: 'REJECTED', reviewedBy: 'fixture-reviewer', reviewedAt: new Date(),
        consentAt: new Date(), privacyNoticeVersion: 'v1', purgedAt: new Date(),
      } }));
      const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, tenantId, queue: 'STANDARD', slaDueAt: new Date(), closedAt: new Date() } }));
      await system(() => app.prisma.reviewDecision.create({ data: { caseId: kase.id, tenantId, reviewerId: 'fixture-reviewer', outcome: 'REJECT', reasonCode, actorFacingCategory: 'WITHDRAWN', timeOnCaseMs: 0 } }));
      expect(await system(() => cash.maybePromoteToL3(id, 'GY')), reasonCode).toBe(false);
      expect(await trust(id)).toBe('L1');
    }
  });

  it('an account under an integrity hold is never promoted automatically', async () => {
    const id = await earner();
    await system(() => app.prisma.enforcementAction.create({ data: { accountId: id, level: 'REVIEW_FIRST', reasonCode: 'VELOCITY_DEVICE', signalsFired: [] as never, decidedBy: 'SYSTEM' } }));
    expect(await system(() => cash.maybePromoteToL3(id, 'GY'))).toBe(false);
    expect(await trust(id)).toBe('L1');
  });

  it('the earned rule still promotes a clean L1 account (no ID needed)', async () => {
    const id = await earner();
    expect(await system(() => cash.maybePromoteToL3(id, 'GY'))).toBe(true);
    expect(await trust(id)).toBe('L3');
  });
});
