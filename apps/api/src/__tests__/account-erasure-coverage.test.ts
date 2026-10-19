/**
 * [GUARDRAILS §2 · REVIEW-F #1879 §4 · COORD 18 Oct 23:28Z + 19 Oct 03:46Z · owner 19 Oct (A/A/A) · #1879 S3-3]
 * The account erasure covers every person table: what goes, what loses what identifies the person, and what
 * stays because it is owed, open, held or payment evidence. One case per table (red on the erasure before this
 * PR), plus the activation write barrier (REVIEW-G's R1 probe and its store variants).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { AccountService } from '../modules/user/account.service';
import { ACCOUNT_CLOSURE_MESSAGE, ACCOUNT_CLOSURE_SUBJECT } from '../modules/user/account-closure';
import { ERASED_TEXT } from '../modules/user/erasure-coverage';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { APPROVAL_TAIL, VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { purgeAuditLogs } from '../lib/audit-immutability';

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
const phoneBase = 592_830_000_000 + Math.floor(Math.random() * 100_000_000);
const T = 'swift-default';
const soon = () => new Date(Date.now() + 86_400_000);

async function person(roles: UserRole[] = ['CUSTOMER']) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Cover', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true,
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(user.id);
  return user.id;
}
const erase = (userId: string) => new AccountService(app).deleteAccount(userId);

async function riderWithSubscription(userId: string) {
  const rider = await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
    vehicleMake: 'Make', vehicleModel: 'Model', vehicleYear: 2020, vehicleColor: 'Red', licensePlate: `PR${nanoid(5)}`,
    currentLat: 6.8, currentLng: -58.1, lastLocationUpdate: new Date() } });
  const now = new Date();
  const sub = await app.prisma.subscription.create({ data: { riderId: rider.id, type: 'DELIVERY_RIDER', weeklyRate: 1000,
    currentPeriodStart: now, currentPeriodEnd: soon(), nextBillingDate: soon() } });
  return { rider, sub };
}
const card = (userId: string, subscriptionId: string, extra: Partial<Prisma.PaymentInstrumentUncheckedCreateInput> = {}) => ({
  subscriptionId, userId, provider: 'simulator', environment: 'sandbox', providerAccount: 'erasure-test',
  vaultTokenSealed: Uint8Array.from(randomBytes(48)), vaultTokenDek: Uint8Array.from(randomBytes(60)),
  brand: 'SIMULATED', last4: '4242', expMonth: 12, expYear: 2030, consentVersion: 'card-on-file-v1', consentAt: new Date(), ...extra,
});
const session = (userId: string, subscriptionId: string, extra: Partial<Prisma.CardSessionUncheckedCreateInput> = {}) => ({
  subscriptionId, userId, purpose: 'ENROLL' as const, provider: 'simulator', environment: 'sandbox', providerAccount: 'erasure-test',
  stateHash: 'ab'.repeat(32), expiresAt: new Date(Date.now() - 60_000), consentVersion: 'card-on-file-v1', consentAt: new Date(), ...extra,
});
async function order(customerId: string) {
  const o = await app.prisma.order.create({ data: {
    orderNumber: `COV-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, status: 'DELIVERED',
    deliveryAddress: 'Somewhere', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
  } });
  orderIds.push(o.id);
  return o;
}
async function store(ownerUserId: string) {
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  return app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Cover ${nanoid(6)}`, slug: `cover-${nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, vendorType: 'RESTAURANT',
    phone: '+5920000000', addressLine1: 'Street', city: 'Georgetown', region: 'Demerara', latitude: 6.8, longitude: -58.15, cuisineTypes: [], tags: [],
  } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
});

afterAll(async () => {
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  const subs = await app.prisma.subscription.findMany({ where: { OR: [
    { rider: { userId: { in: userIds } } }, { driver: { userId: { in: userIds } } }, { vendor: { owner: { userId: { in: userIds } } } },
  ] }, select: { id: true } });
  await quiet(cleanupPayerBillingClocks(app.prisma, userIds));
  const mine = { userId: { in: userIds } };
  for (const step of [
    () => app.prisma.supportTicket.deleteMany({ where: mine }), () => app.prisma.strike.deleteMany({ where: mine }),
    () => app.prisma.complianceViolation.deleteMany({ where: mine }), () => app.prisma.complianceReviewCase.deleteMany({ where: mine }),
    () => app.prisma.rectificationRequest.deleteMany({ where: mine }), () => app.prisma.contentReport.deleteMany({ where: { reporterId: { in: userIds } } }),
    () => app.prisma.ratingReport.deleteMany({ where: { reporterId: { in: userIds } } }), () => app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } }),
    () => app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: userIds } } }),
    () => app.prisma.tripSafetySession.deleteMany({ where: { OR: [{ passengerUserId: { in: userIds } }, { driverUserId: { in: userIds } }] } }),
    () => app.prisma.evidenceBundle.deleteMany({ where: { subjectUserId: { in: userIds } } }), () => app.prisma.incidentCase.deleteMany({ where: { subjectUserId: { in: userIds } } }),
    () => app.prisma.fraudCase.deleteMany({ where: { subjectUserId: { in: userIds } } }), () => app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: { in: userIds } } }),
    () => app.prisma.safetyDeletionHold.deleteMany({ where: mine }), () => app.prisma.checkoutReceipt.deleteMany({ where: mine }),
    () => app.prisma.moverRevocationOutbox.deleteMany({ where: mine }), () => app.prisma.verificationDecisionOutbox.deleteMany({ where: mine }),
    () => app.prisma.renewalSchedule.deleteMany({ where: { subjectId: { in: userIds } } }), () => app.prisma.verificationDocument.deleteMany({ where: mine }),
  ]) await quiet(step());
  await quiet(app.prisma.custodyRecoveryCase.deleteMany({ where: { orderId: { in: orderIds } } }));
  await quiet(app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }));
  await quiet(app.prisma.subscription.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } }));
  await quiet(app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } }));
  for (const step of [
    () => app.prisma.vendorOwner.deleteMany({ where: mine }), () => app.prisma.rider.deleteMany({ where: mine }),
    () => app.prisma.driver.deleteMany({ where: mine }), () => app.prisma.serviceProvider.deleteMany({ where: mine }),
    () => app.prisma.customer.deleteMany({ where: mine }),
  ]) await quiet(step());
  await quiet(app.prisma.user.deleteMany({ where: { id: { in: userIds } } }));
  await quiet(purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] }, 'test-cleanup:account-erasure-coverage'));
  await app.close();
});

describe('[COORD 23:28Z] owed rows go with the account (in the erasure transaction)', () => {
  it('notices, staged money-setting commands, renewal reminders and staff permissions are deleted', async () => {
    const u = await person();
    await app.prisma.notification.create({ data: { userId: u, type: 'SYSTEM_ANNOUNCEMENT', title: 'Your order', body: 'Names a person' } });
    await app.prisma.moneySurfaceCommand.create({ data: { actor: 'DRIVER', entityId: `ent-${nanoid(8)}`, userId: u, kind: 'MMG_LINK_STAGE',
      state: 'DECIDED', generation: 1, oldDigest: 'a', newDigest: 'b', noticePayload: { title: 'Staged' } } });
    const doc = await app.prisma.verificationDocument.create({ data: { userId: u, role: 'CUSTOMER', docType: 'police_clearance', fileUrl: '' } });
    await app.prisma.renewalSchedule.create({ data: { tenantId: T, documentId: doc.id, subjectId: u, expiresOn: soon(), notifyAt: [soon()], suspendAt: soon() } });
    await app.prisma.admin.create({ data: { userId: u, permissions: ['orders:read'] } });
    await erase(u);
    expect(await Promise.all([
      app.prisma.notification.count({ where: { userId: u } }),
      app.prisma.moneySurfaceCommand.count({ where: { userId: u } }),
      app.prisma.renewalSchedule.count({ where: { subjectId: u } }),
      app.prisma.admin.count({ where: { userId: u } }),
    ])).toEqual([0, 0, 0, 0]);
  });

  it('a processed mover revocation goes at once; one still owed to other people stays until done, then the re-sweep deletes it', async () => {
    const u = await person();
    const done = await app.prisma.moverRevocationOutbox.create({ data: { id: `mro_${nanoid(10)}`, dedupeKey: `cov:${nanoid(10)}`, userId: u, payload: {}, processedAt: new Date() } });
    const owed = await app.prisma.moverRevocationOutbox.create({ data: { id: `mro_${nanoid(10)}`, dedupeKey: `cov:${nanoid(10)}`, userId: u, payload: {} } });
    await erase(u);
    expect(await app.prisma.moverRevocationOutbox.findMany({ where: { userId: u }, select: { id: true } })).toEqual([{ id: owed.id }]);
    expect(await app.prisma.moverRevocationOutbox.count({ where: { id: done.id } })).toBe(0);
    await app.prisma.moverRevocationOutbox.update({ where: { id: owed.id }, data: { processedAt: new Date() } });
    await erase(u); // the standing re-sweep
    expect(await app.prisma.moverRevocationOutbox.count({ where: { userId: u } })).toBe(0);
  });

  it('safety check-in deliveries go unless a safety deletion hold is open; the re-sweep after its release deletes them', async () => {
    const free = await person();
    const heldUser = await person();
    for (const u of [free, heldUser]) {
      const s = await app.prisma.tripSafetySession.create({ data: { tenantId: T, orderId: `ord-${nanoid(8)}`, orderType: 'TAXI', driverUserId: u, status: 'CLOSED', closedAt: new Date() } });
      await app.prisma.guardianCheckinDelivery.create({ data: { tenantId: T, sessionId: s.id, cycleId: 'c1', level: 'SOFT', recipient: 'DRIVER', userId: u, payload: { text: 'Are you safe?' } } });
    }
    await app.prisma.safetyDeletionHold.create({ data: { userId: heldUser, reasons: ['SOS_OPEN'], holdRefs: {}, purpose: 'test', fields: [], ownerRole: 'DRIVER', reviewBy: soon(), purgeBy: soon() } });
    await erase(free);
    await erase(heldUser);
    expect(await app.prisma.guardianCheckinDelivery.count({ where: { userId: free } })).toBe(0);
    expect(await app.prisma.guardianCheckinDelivery.count({ where: { userId: heldUser } })).toBe(1);
    await app.prisma.safetyDeletionHold.update({ where: { userId: heldUser }, data: { status: 'RELEASED' } });
    await erase(heldUser);
    expect(await app.prisma.guardianCheckinDelivery.count({ where: { userId: heldUser } })).toBe(0);
  });
});

describe('[COORD 03:46Z] cards: every saved card leaves service; payment evidence stays', () => {
  it('an ACTIVE card is REVOKED by the erasure (the PT-1 row stays, frozen); its unsent charges are closed', async () => {
    const u = await person(['CUSTOMER', 'MOVER']);
    const { sub } = await riderWithSubscription(u);
    const active = await app.prisma.paymentInstrument.create({ data: card(u, sub.id) });
    await erase(u);
    const after = await app.prisma.paymentInstrument.findUniqueOrThrow({ where: { id: active.id } });
    expect({ status: after.status, revokedBy: after.revokedBy, revoked: after.revokedAt !== null }).toEqual({ status: 'REVOKED', revokedBy: u, revoked: true });
    expect(await app.prisma.auditLog.count({ where: { action: 'CARD_REVOKED_ACCOUNT_DELETED', entityId: active.id } })).toBe(1);
  });

  it('a card session that moved no money goes; one with a provider transaction (payment evidence) stays', async () => {
    const u = await person(['CUSTOMER', 'MOVER']);
    const { sub } = await riderWithSubscription(u);
    const idle = await app.prisma.cardSession.create({ data: session(u, sub.id, { status: 'EXPIRED' }) });
    const evidence = await app.prisma.cardSession.create({ data: session(u, sub.id, { status: 'FAILED', purpose: 'PAY_NOW', amount: 1000, currencyCode: 'GYD', periodStart: new Date(), providerTransactionRef: `ptx-${nanoid(8)}` }) });
    await erase(u);
    expect(await app.prisma.cardSession.findMany({ where: { userId: u }, select: { id: true } })).toEqual([{ id: evidence.id }]);
    expect(await app.prisma.cardSession.count({ where: { id: idle.id } })).toBe(0);
  });
});

describe('[COORD 23:28Z] kept rows lose what identifies the person', () => {
  it('the checkout replay record keeps its order ids and date; the frozen response and request hash are replaced', async () => {
    const u = await person();
    const r = await app.prisma.checkoutReceipt.create({ data: { userId: u, idempotencyKey: nanoid(12), requestHash: 'f'.repeat(64), orderIds: ['o1'],
      result: { orders: [{ deliveryAddress: 'Home street', customerPhone: '+5920000001', notes: 'gate code' }] } } });
    await erase(u);
    const after = await app.prisma.checkoutReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect({ orderIds: after.orderIds, createdAt: after.createdAt, result: after.result, requestHash: after.requestHash })
      .toEqual({ orderIds: ['o1'], createdAt: r.createdAt, result: { erased: true }, requestHash: ERASED_TEXT });
  });

  it('rider, driver and provider profiles keep the row and lose vehicle, plate, location, pay link and bio; the referral link goes', async () => {
    const u = await person(['CUSTOMER', 'MOVER']);
    const { rider } = await riderWithSubscription(u);
    const driver = await app.prisma.driver.create({ data: { userId: u, vehicleMake: 'Make', vehicleModel: 'Model', vehicleYear: 2021, vehicleColor: 'Blue',
      licensePlate: `PD${nanoid(5)}`, driverLicenseUrl: '', vehicleInsuranceUrl: '', colorHex: '#0000ff', currentLat: 6.8, currentLng: -58.1, mmgPayUrl: 'https://pay.example/x' } });
    const provider = await app.prisma.serviceProvider.create({ data: { userId: u, trade: 'Plumber', bio: 'My name and my street', portfolioPhotos: ['https://x/p.jpg'] } });
    const referrer = await app.prisma.customer.findUniqueOrThrow({ where: { userId: await person() } });
    const mine = await app.prisma.customer.update({ where: { userId: u }, data: { referredBy: referrer.id } });
    await erase(u);
    const [r, d, p, c] = await Promise.all([
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }), app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }),
      app.prisma.serviceProvider.findUniqueOrThrow({ where: { id: provider.id } }), app.prisma.customer.findUniqueOrThrow({ where: { id: mine.id } }),
    ]);
    expect([r.vehicleMake, r.vehicleModel, r.vehicleYear, r.vehicleColor, r.licensePlate, r.currentLat, r.currentLng, r.lastLocationUpdate]).toEqual([null, null, null, null, null, null, null, null]);
    expect([d.vehicleMake, d.vehicleModel, d.vehicleColor, d.licensePlate, d.colorHex, d.currentLat, d.currentLng, d.mmgPayUrl]).toEqual(['', '', '', '', null, null, null, null]);
    expect([p.trade, p.bio, p.portfolioPhotos]).toEqual(['Plumber', null, []]);
    expect({ referredBy: c.referredBy, retired: c.referralCode.startsWith('retired-'), totalOrders: c.totalOrders }).toEqual({ referredBy: null, retired: true, totalOrders: mine.totalOrders });
  });
});

describe('[owner 19 Oct G1 + G2] fraud marks and case rows stay without their identifying text', () => {
  it('a strike and an enforcement action keep the row (reason, order link, dates) without phone, address key, signals and appeal text', async () => {
    const u = await person();
    const s = await app.prisma.strike.create({ data: { userId: u, reason: 'failed_payment_absent', phone: '+5920000002', addressKey: 'addr-key', orderId: 'ord-1' } });
    const e = await app.prisma.enforcementAction.create({ data: { accountId: u, level: 'DENY_TRIAL', reasonCode: 'TRIAL_CONSUMED', signalsFired: [{ phoneHash: 'x' }], decidedBy: 'SYSTEM', appealNote: 'It was my brother' } });
    await erase(u);
    const [sa, ea] = await Promise.all([app.prisma.strike.findUniqueOrThrow({ where: { id: s.id } }), app.prisma.enforcementAction.findUniqueOrThrow({ where: { id: e.id } })]);
    expect({ reason: sa.reason, orderId: sa.orderId, phone: sa.phone, addressKey: sa.addressKey }).toEqual({ reason: 'failed_payment_absent', orderId: 'ord-1', phone: null, addressKey: null });
    expect({ reasonCode: ea.reasonCode, level: ea.level, signalsFired: ea.signalsFired, appealNote: ea.appealNote }).toEqual({ reasonCode: 'TRIAL_CONSUMED', level: 'DENY_TRIAL', signalsFired: [], appealNote: null });
  });

  it('case and request text goes; the confirmed closure request, a report still being handled and one sent to the authorities keep theirs', async () => {
    const u = await person();
    const other = await person();
    const ticket = await app.prisma.supportTicket.create({ data: { userId: u, category: 'ORDER_ISSUE', subject: 'My address is', message: 'Call me at home', adminNote: 'Spoke to her' } });
    const closure = await app.prisma.supportTicket.create({ data: { userId: u, category: 'ACCOUNT', subject: ACCOUNT_CLOSURE_SUBJECT, message: ACCOUNT_CLOSURE_MESSAGE } });
    const violation = await app.prisma.complianceViolation.create({ data: { userId: u, moverKind: 'RIDER', reason: 'manual_review_failed', evidence: { note: 'free text' }, actionTaken: 'NONE' } });
    const review = await app.prisma.complianceReviewCase.create({ data: { userId: u, dueAt: soon(), note: 'Free text about them' } });
    const rect = await app.prisma.rectificationRequest.create({ data: { tenantId: T, userId: u, submissionId: 'sub-1', caseId: randomUUID(), fieldCode: 'NAME', note: 'My real name is' } });
    const resolved = await app.prisma.contentReport.create({ data: { reporterId: u, targetType: 'USER', targetId: other, reason: 'HARASSMENT', detail: 'What he said', status: 'ACTIONED', resolutionNote: 'Warned' } });
    const pending = await app.prisma.contentReport.create({ data: { reporterId: u, targetType: 'USER', targetId: `${other}-2`, reason: 'SPAM', detail: 'Still open', status: 'PENDING' } });
    const lawful = await app.prisma.contentReport.create({ data: { reporterId: u, targetType: 'USER', targetId: `${other}-3`, reason: 'CSAE', detail: 'Reported on', status: 'ACTIONED', authorityRef: 'REF-1' } });
    const rating = await app.prisma.ratingReport.create({ data: { tenantId: T, ratingId: `rt-${nanoid(8)}`, reporterId: u, reason: 'ABUSIVE', note: 'Free text', status: 'DISMISSED' } });
    await erase(u);
    const t = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect([t.category, t.subject, t.message, t.adminNote]).toEqual(['ORDER_ISSUE', ERASED_TEXT, ERASED_TEXT, null]);
    const c = await app.prisma.supportTicket.findUniqueOrThrow({ where: { id: closure.id } });
    expect([c.subject, c.message]).toEqual([ACCOUNT_CLOSURE_SUBJECT, ACCOUNT_CLOSURE_MESSAGE]);
    expect((await app.prisma.complianceViolation.findUniqueOrThrow({ where: { id: violation.id } })).evidence).toEqual({});
    expect((await app.prisma.complianceReviewCase.findUniqueOrThrow({ where: { id: review.id } })).note).toBeNull();
    expect((await app.prisma.rectificationRequest.findUniqueOrThrow({ where: { id: rect.id } })).note).toBe(ERASED_TEXT);
    const reports = await app.prisma.contentReport.findMany({ where: { id: { in: [resolved.id, pending.id, lawful.id] } }, select: { id: true, detail: true, resolutionNote: true } });
    expect(reports.find((r) => r.id === resolved.id)).toEqual({ id: resolved.id, detail: null, resolutionNote: null });
    expect(reports.find((r) => r.id === pending.id)?.detail).toBe('Still open');
    expect(reports.find((r) => r.id === lawful.id)?.detail).toBe('Reported on');
    expect((await app.prisma.ratingReport.findUniqueOrThrow({ where: { id: rating.id } })).note).toBeNull();
  });
});

describe('[owner 19 Oct G3] safety records: whole while open or held, otherwise without location, address and free text', () => {
  it('a closed, unheld SOS, trip session, incident, unsealed evidence and fraud case are de-identified; status, dates and order link stay', async () => {
    const u = await person();
    const sos = await app.prisma.sosAlert.create({ data: { tenantId: T, actorUserId: u, actorRole: 'CUSTOMER', orderId: 'ord-s', status: 'RESOLVED', resolvedAt: new Date(),
      triggerLat: 6.8, triggerLng: -58.1, triggerAddressText: 'My street', triggerNote: 'Help', resolutionNotes: 'Called her' } });
    await app.prisma.sosRetrigger.create({ data: { tenantId: T, sosAlertId: sos.id, seq: 1, at: new Date(), source: 'BUTTON', actorRole: 'CUSTOMER', lat: 6.8, lng: -58.1, note: 'Again' } });
    const tripOrder = `ord-${nanoid(8)}`;
    const trip = await app.prisma.tripSafetySession.create({ data: { tenantId: T, orderId: tripOrder, orderType: 'TAXI', passengerUserId: u, driverUserId: `drv-${nanoid(6)}`, status: 'CLOSED', closedAt: new Date(),
      riskFactors: { night: true }, deviationState: { lat: 6.8, lng: -58.1 } } });
    const kase = await app.prisma.incidentCase.create({ data: { tenantId: T, caseNumber: `IC-${nanoid(8)}`, status: 'CLOSED', closedAt: new Date(), severity: 'S3', category: 'other', intake: 'OPS_CREATED',
      subjectUserId: u, orderId: 'ord-s', summary: 'What happened to her', details: { where: 'street' }, decisionNotes: 'Notes', slaAckBy: new Date(), slaDecideBy: new Date(), interimAction: 'NONE' } });
    const bundle = await app.prisma.evidenceBundle.create({ data: { tenantId: T, bundleNumber: `EB-${nanoid(8)}`, caseId: kase.id, subjectUserId: u } });
    await app.prisma.evidenceItem.create({ data: { bundleId: bundle.id, kind: 'LOCATION_FIX', label: 'fix', content: { lat: 6.8 }, contentHash: 'h'.repeat(64) } });
    const fraudCaseId = randomUUID();
    const fraud = await app.prisma.fraudCase.create({ data: { tenantId: T, subjectUserId: u, submissionId: 'sub-f', caseId: fraudCaseId, reasonCode: 'DOC_FORGED', confirmedBy: 'admin-x', linkedAccountIds: ['acc-2'], referral: 'Referred with her details' } });
    await erase(u);
    const a = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: sos.id } });
    expect([a.status, a.orderId, a.triggerLat, a.triggerLng, a.triggerAddressText, a.triggerNote, a.resolutionNotes, a.resolvedAt !== null]).toEqual(['RESOLVED', 'ord-s', null, null, null, null, null, true]);
    expect(await app.prisma.sosRetrigger.count({ where: { sosAlertId: sos.id } })).toBe(0);
    const s = await app.prisma.tripSafetySession.findUniqueOrThrow({ where: { id: trip.id } });
    expect([s.status, s.orderId, s.riskFactors, s.deviationState]).toEqual(['CLOSED', tripOrder, null, null]);
    const k = await app.prisma.incidentCase.findUniqueOrThrow({ where: { id: kase.id } });
    expect([k.status, k.orderId, k.caseNumber, k.summary, k.details, k.decisionNotes]).toEqual(['CLOSED', 'ord-s', kase.caseNumber, ERASED_TEXT, null, null]);
    expect(await app.prisma.evidenceItem.count({ where: { bundleId: bundle.id } })).toBe(0);
    const f = await app.prisma.fraudCase.findUniqueOrThrow({ where: { id: fraud.id } });
    expect([f.reasonCode, f.caseId, f.referral, f.linkedAccountIds]).toEqual(['DOC_FORGED', fraudCaseId, ERASED_TEXT, []]);
  });

  it('a closed case under a legal hold stays whole, and so do the SOS it covers and the trip session escalated into that SOS', async () => {
    const u = await person();
    const other = `other-${nanoid(6)}`;
    const sos = await app.prisma.sosAlert.create({ data: { tenantId: T, actorUserId: u, actorRole: 'CUSTOMER', status: 'RESOLVED', resolvedAt: new Date(), triggerLat: 6.8, triggerNote: 'Covered' } });
    const held = await app.prisma.incidentCase.create({ data: { tenantId: T, caseNumber: `IC-${nanoid(8)}`, status: 'CLOSED', closedAt: new Date(), severity: 'S2', category: 'other', intake: 'OPS_CREATED',
      subjectUserId: u, summary: 'Held summary', legalHold: true, slaAckBy: new Date(), slaDecideBy: new Date(), interimAction: 'NONE' } });
    await app.prisma.incidentCase.create({ data: { tenantId: T, caseNumber: `IC-${nanoid(8)}`, status: 'CLOSED', closedAt: new Date(), severity: 'S2', category: 'other', intake: 'SOS_RESOLUTION',
      subjectUserId: other, sosAlertId: sos.id, summary: 'About the SOS', legalHold: true, slaAckBy: new Date(), slaDecideBy: new Date(), interimAction: 'NONE' } });
    const trip = await app.prisma.tripSafetySession.create({ data: { tenantId: T, orderId: `ord-${nanoid(8)}`, orderType: 'TAXI', passengerUserId: u, driverUserId: other, status: 'CLOSED', closedAt: new Date(),
      escalatedToSosId: sos.id, riskFactors: { night: true } } });
    await erase(u);
    expect((await app.prisma.incidentCase.findUniqueOrThrow({ where: { id: held.id } })).summary).toBe('Held summary');
    expect((await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: sos.id } })).triggerNote).toBe('Covered');
    expect((await app.prisma.tripSafetySession.findUniqueOrThrow({ where: { id: trip.id } })).riskFactors).toEqual({ night: true });
  });

  it('an open case: the erasure opens a safety deletion hold, so every safety record stays whole', async () => {
    const u = await person();
    const open = await app.prisma.incidentCase.create({ data: { tenantId: T, caseNumber: `IC-${nanoid(8)}`, status: 'INVESTIGATING', severity: 'S2', category: 'other', intake: 'OPS_CREATED',
      subjectUserId: u, summary: 'Open summary', slaAckBy: new Date(), slaDecideBy: new Date(), interimAction: 'NONE' } });
    const closed = await app.prisma.incidentCase.create({ data: { tenantId: T, caseNumber: `IC-${nanoid(8)}`, status: 'CLOSED', closedAt: new Date(), severity: 'S3', category: 'other', intake: 'OPS_CREATED',
      subjectUserId: u, summary: 'Closed while another is open', slaAckBy: new Date(), slaDecideBy: new Date(), interimAction: 'NONE' } });
    await erase(u);
    const rows = await app.prisma.incidentCase.findMany({ where: { id: { in: [open.id, closed.id] } }, select: { summary: true }, orderBy: { summary: 'asc' } });
    expect(rows.map((r) => r.summary)).toEqual(['Closed while another is open', 'Open summary']);
  });

  it('a hold is read inside the erasure transaction: a person under a legal hold keeps their safety records; after release the re-sweep de-identifies them', async () => {
    const u = await person();
    const sos = await app.prisma.sosAlert.create({ data: { tenantId: T, actorUserId: u, actorRole: 'CUSTOMER', status: 'CANCELLED', cancelledAt: new Date(), triggerLat: 6.8, triggerLng: -58.1, triggerNote: 'Held' } });
    const hold = await app.prisma.docLegalHold.create({ data: { tenantId: T, subjectUserId: u, reason: 'court order', ownerId: 'admin-x', placedBy: 'admin-x', reviewBy: soon() } });
    await erase(u);
    expect((await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: sos.id } })).triggerNote).toBe('Held');
    await app.prisma.docLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedBy: 'admin-x' } });
    await erase(u);
    const a = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: sos.id } });
    expect([a.triggerLat, a.triggerLng, a.triggerNote]).toEqual([null, null, null]);
  });

  it('a resolved parcel recovery case the person held as a rider loses its location and note; its staff owner stays', async () => {
    const u = await person(['CUSTOMER', 'MOVER']);
    const { rider } = await riderWithSubscription(u);
    const o = await order(await person());
    const c = await app.prisma.custodyRecoveryCase.create({ data: { tenantId: T, orderId: o.id, reason: 'VEHICLE_BREAKDOWN', holderRiderId: rider.id, deadlineAt: soon(),
      incidentLat: 6.8, incidentLng: -58.1, reasonNote: 'Broke down near my house', ownerUserId: 'staff-1', resolvedAt: new Date(), state: 'DELIVERED' } });
    await erase(u);
    const after = await app.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: c.id } });
    expect([after.state, after.ownerUserId, after.incidentLat, after.incidentLng, after.reasonNote]).toEqual(['DELIVERED', 'staff-1', null, null, null]);
  });
});

describe('[#1879 S3-3 · REVIEW-G R1] no activation write for an erased account', () => {
  it('an erasure that commits inside the approval tail: the erased mover gets no trial and no plate key', async () => {
    const u = await person();
    const driver = await app.prisma.driver.create({ data: { userId: u, vehicleMake: 'Synthetic', vehicleModel: 'Car', vehicleYear: 2025, vehicleColor: 'Blue', licensePlate: `PR${nanoid(5)}`, driverLicenseUrl: '', vehicleInsuranceUrl: '' } });
    const documentId = `doc-${nanoid(8)}`;
    await app.prisma.verificationDecisionOutbox.create({ data: { tenantId: T, documentId, userId: u, command: APPROVAL_TAIL } });
    const svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    const standing = vi.spyOn(app.prisma.verificationDocument, 'findUnique').mockImplementationOnce((async () => ({ state: 'COMMITTED' })) as never);
    let erased: unknown;
    // The tail's last read before its writes: the erasure commits here, after the tail's barrier check.
    const verified = vi.spyOn(VerificationService.prototype as never, 'isRoleVerified' as never).mockImplementationOnce((async () => {
      erased = await erase(u);
      return true;
    }) as never);
    try { await svc.processDecisionOutbox({ documentId, now: new Date(Date.now() + 1000) }); } finally { standing.mockRestore(); verified.mockRestore(); }
    expect(erased).toMatchObject({ deleted: true });
    expect(await app.prisma.subscription.findMany({ where: { driverId: driver.id }, select: { status: true } })).toEqual([]);
    expect(await app.prisma.identityKey.count({ where: { accountId: u, type: 'PLATE' } })).toBe(0);
  });

  it("an erased owner's store is given no trial (the activation re-reads the person under the lock)", async () => {
    const u = await person();
    const v = await store(u);
    await erase(u);
    await expect(new SubscriptionService(app.prisma).startTrialForVendor(v.id)).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' });
    expect(await app.prisma.subscription.count({ where: { vendorId: v.id } })).toBe(0);
  });

  it("an erased owner's stores are projected nothing (no flags, no promotion, no trial)", async () => {
    const u = await person();
    await store(u);
    await erase(u);
    const svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
    const checklist = vi.spyOn(VerificationService.prototype as never, 'isRoleVerified' as never) as unknown as { mock: { calls: unknown[][] }; mockRestore(): void };
    try {
      await (svc as unknown as { projectVendorActivation: (db: unknown, userId: string) => Promise<void> }).projectVendorActivation(app.prisma, u);
      expect(checklist.mock.calls.length).toBe(0);
    } finally { checklist.mockRestore(); }
  });

  it('an erasure that starts while a store activation holds the person waits for it, then winds the new trial down', async () => {
    const u = await person();
    const v = await store(u);
    const subs = new SubscriptionService(app.prisma);
    let erasure: Promise<unknown> | undefined;
    const original = (SubscriptionService.prototype as unknown as { activation: (...a: unknown[]) => Promise<unknown> }).activation;
    const hook = vi.spyOn(SubscriptionService.prototype as never, 'activation' as never).mockImplementationOnce((async function (this: unknown, ...args: unknown[]) {
      erasure = erase(u);
      await new Promise((r) => setTimeout(r, 400));
      return original.apply(this, args);
    }) as never);
    try { await subs.startTrialForVendor(v.id); } finally { hook.mockRestore(); }
    await erasure;
    expect((await app.prisma.subscription.findMany({ where: { vendorId: v.id }, select: { status: true } })).map((s) => s.status)).toEqual(['CANCELLED']);
  });
});
