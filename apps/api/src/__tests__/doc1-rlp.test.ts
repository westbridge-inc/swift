/**
 * [DOC-1 §31.4 · DOC-INV-47 · P31-1] test_no_rlp_payout_without_evidence
 *
 * Rider Loss Protection is a POLICY, not a sentence: the covered amount is what the
 * rider fronted (the food cost, never the delivery fee) and is capped at the ID gate;
 * a rolling 30-day cap and a review threshold route claims to a person; a suspended
 * protection is stated, audited and told, never silent; every payout is drawn from a
 * named, funded reserve line or refused; and — the invariant — nobody is paid without
 * a complete evidence bundle assembled from the artefacts the platform already holds.
 *
 * [SAFE-B] The bundle is read from the immutable filing the handover writes: the fix
 * the mover's own session persisted, the photo the server issued, the stored arrival.
 * A claim planted without a filing is history only and can never complete; a positive
 * payout is shown on a real filing. Filings, proofs, claims and reserve entries are
 * retained evidence, so this suite deletes none of them and stays correct on a
 * database that keeps every earlier run: country-wide reserve figures are asserted as
 * deltas, and references, doors and provisioning periods are unique to the run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { CashRulesService, DEFAULT_CASH_RULES } from '../modules/cash/cash-rules.service';
import {
  LOSS_PROTECTION_DEFAULTS, LOSS_PROTECTION_FLAGS, assembleClaimEvidence, provisionReserveForPreviousMonth, reserveBalance,
  rlpReserveDdl, sweepLossProtection,
} from '../modules/cash/rlp';
import { NO_SHOW_EVIDENCE_MAX_AGE_MS } from '../modules/order/cancel-policy';
import { issueSyntheticHandoverPhoto, persistSessionFix, syntheticMoverSession } from './helpers/handover-proof';
import { retainedPhonePrefix } from './helpers/retained-evidence';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
/** [SAFE-B · retained history] A phone namespace no other suite uses or purges, unique to the run. */
const PHONE_PREFIX = retainedPhonePrefix('01');
const HOUR = 3_600_000;
const DOOR = { lat: 6.8123, lng: -58.1601 };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-rlp-test');
/** A country nobody else uses: the reserve ledger is per country, so this suite owns its own line. */
const COUNTRY = 'GY';

let app: FastifyInstance;
let notifications: NotificationService;
let cash: CashRulesService;
let customerId = '', riderUserId = '', riderId = '', riderSessionId = '', vendorOwnerId = '', vendorId = '', itemId = '';
let gateLocal = 0;
type Pair = { customerId: string; riderUserId: string; riderId: string; sessionId: string };
let mkUser: (n: number, roles: string[], active: string, extra?: Record<string, unknown>) => Promise<{ id: string }>;
/** The fraud guardrails (pair, address, monthly count) are keyed on the mover and the customer:
 *  a test that needs a CLEAN claim gets its own pair at its own door. The mover signs in
 *  (a session of its own) and that session owns the fix the location stream persists. */
async function freshPair(n: number, door: { lat: number; lng: number }): Promise<Pair> {
  const c = await mkUser(n, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  const r = await mkUser(n + 1, ['MOVER'], 'MOVER');
  const sessionId = await system(() => syntheticMoverSession(app.prisma, r.id, `rlp-${RUN}`));
  const rider = await system(() => app.prisma.rider.create({ data: { userId: r.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentLat: door.lat, currentLng: door.lng, lastLocationUpdate: new Date(), locationSessionId: sessionId } }));
  return { customerId: c.id, riderUserId: r.id, riderId: rider.id, sessionId };
}
/** A door of this run's own at the address key's 4-decimal precision, used only if no retained strike sits
 *  at its key: a strike an earlier run left at a fixed door would co-fire collusion_address on a claim this
 *  run expects to be clean. */
const RUN_BASE = { lat: 6.2 + Math.floor(Math.random() * 10_000) * 0.0001, lng: -58.9 + Math.floor(Math.random() * 6_000) * 0.0001 };
let doorSeq = 0;
const ownDoor = async () => {
  for (;;) {
    doorSeq += 1;
    const door = { lat: Number((RUN_BASE.lat + doorSeq * 0.0007).toFixed(4)), lng: Number((RUN_BASE.lng - doorSeq * 0.0007).toFixed(4)) };
    const struck = await system(() => app.prisma.strike.count({ where: { addressKey: `geo:${door.lat.toFixed(4)}:${door.lng.toFixed(4)}` } }));
    if (struck === 0) return door;
  }
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.ready();
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  notifications = new NotificationService(app.prisma, ioStub);
  cash = new CashRulesService(app.prisma, notifications, new OrderService(app.prisma, ioStub));
  const mk = (n: number, roles: string[], active: string, extra: Record<string, unknown> = {}) => runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `${PHONE_PREFIX}${String(n).padStart(3, '0')}`, firstName: 'Loss', lastName: `Protect${n}`, roles: roles as never, activeRole: active as never, countryCode: COUNTRY, status: 'ACTIVE', isPhoneVerified: true, trustLevel: 'L2', ...extra,
  } as never }));
  mkUser = mk;
  const c = await mk(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } }); customerId = c.id;
  const r = await mk(2, ['MOVER'], 'MOVER'); riderUserId = r.id;
  riderSessionId = await system(() => syntheticMoverSession(app.prisma, riderUserId, `rlp-${RUN}`));
  riderId = (await system(() => app.prisma.rider.create({ data: { userId: riderUserId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date(), locationSessionId: riderSessionId } }))).id;
  const v = await mk(3, ['VENDOR_OWNER'], 'VENDOR_OWNER'); vendorOwnerId = v.id;
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: vendorOwnerId, vendors: { create: {
    name: `Loss Store ${RUN}`, slug: `loss-store-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}999`, addressLine1: '3 Test St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'ACTIVE',
  } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
  const category = await system(() => app.prisma.category.create({ data: { vendorId, name: `Menu ${RUN}`, sortOrder: 0 } }));
  itemId = (await system(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: `Plate ${RUN}`, basePrice: 1000 } as never }))).id;
  gateLocal = await cash['countryConfig'].getIdGateThresholdLocal(COUNTRY);
  expect(gateLocal).toBeGreaterThan(1000);
});

afterAll(async () => {
  // [SAFE-B · retained history] The filings, issued proofs, claims, strikes and reserve entries this suite
  // wrote are evidence and money records: they are kept, and so is every row they reference (orders, their
  // status logs and items, the users, riders and the store). Deleting a reserve entry would also move the
  // country's reserve for every later suite. Nothing is deleted. The store alone is taken out of service, so
  // a retained fixture can never be offered to another suite's customer; the evidence is untouched by that.
  try {
    if (vendorId) await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'CLOSED', acceptingOrders: false } }));
  } finally {
    await app.close();
  }
});

/** A cash delivery order at the door, with the artefacts a real one carries: cart, pickup, arrival. */
async function atDoorOrder(opts: { food: number; fee?: number; arrived?: boolean; pickedUp?: boolean; cart?: boolean; status?: string; pair?: Pair; door?: { lat: number; lng: number } } ) {
  const fee = opts.fee ?? 500;
  const who = opts.pair ?? defaultPair();
  const door = opts.door ?? DOOR;
  const order = await system(() => app.prisma.order.create({ data: {
    orderNumber: `RL${NUM}${nanoid(4).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase()}`, customerId: who.customerId, vendorId, riderId: who.riderId, status: (opts.status ?? 'ARRIVED') as never, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    paymentMethod: 'CASH', paymentStatus: 'PENDING', subtotalBase: opts.food, subtotalMarkup: 0, subtotalCustomer: opts.food, deliveryFee: fee, tipAmount: 0, totalAmount: opts.food + fee,
    deliveryAddress: '9 Cash Street', deliveryLat: door.lat, deliveryLng: door.lng, pickupLat: 6.8, pickupLng: -58.16, pickupAddress: 'Vendor corner',
    ...(opts.cart === false ? {} : { items: { create: { itemId, name: 'Plate', quantity: 1, basePrice: opts.food, markedUpPrice: opts.food, markupAmount: 0, totalBase: opts.food, totalMarkup: 0, totalCustomer: opts.food, selectedOptions: {} } } }),
  } as never }));
  const t = Date.now();
  if (opts.pickedUp !== false) await system(() => app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'PICKED_UP', changedBy: who.riderId, note: 'fixture pickup', createdAt: new Date(t - 40 * 60_000) } }));
  if (opts.arrived !== false) await system(() => app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'ARRIVED', changedBy: who.riderId, note: 'fixture arrival', createdAt: new Date(t - 10 * 60_000) } }));
  return order;
}

/** A claim planted directly, the way older fixtures did — the invariant must hold for those too. */
async function plantClaim(orderId: string, amount: number, extra: Record<string, unknown> = {}) {
  return system(() => app.prisma.reimbursementClaim.create({ data: {
    orderId, riderId, customerId, amount, reason: 'no_show', gpsLat: DOOR.lat, gpsLng: DOOR.lng, status: 'AUTO_APPROVED', flags: [], ...extra,
  } as never }));
}

const defaultPair = (): Pair => ({ customerId, riderUserId, riderId, sessionId: riderSessionId });

/** [SAFE-B] The real filing: the mover's own session persists a fresh fix (at the door unless told
 *  otherwise), the server issues the door photo, and the handover files it. Any one artefact can be
 *  withheld or replaced by a declaration to show the bundle notices. */
async function file(
  order: { id: string },
  outcome: 'no_show' | 'refused',
  opts: { pair?: Pair; door?: { lat: number; lng: number }; fixAt?: { lat: number; lng: number }; fixAgeMs?: number; photo?: false | string } = {},
) {
  const who = opts.pair ?? defaultPair();
  const door = opts.door ?? DOOR;
  await system(() => persistSessionFix(app.prisma, { riderId: who.riderId }, who.sessionId, opts.fixAt ?? door, opts.fixAgeMs ?? 0));
  const photoUrl = opts.photo === false ? undefined
    : opts.photo ?? (await system(() => issueSyntheticHandoverPhoto(app.prisma, { orderId: order.id, actorId: who.riderUserId, role: 'RIDER' }))).url;
  return system(() => cash.handover(order.id, who.riderUserId, {
    outcome, gps: door, sessionId: who.sessionId, ...(photoUrl ? { photoUrl } : {}),
  }));
}

const fund = (amount: number) => system(() => app.prisma.rlpReserveEntry.create({ data: { countryCode: COUNTRY, kind: 'ADJUSTMENT', amount, note: `fixture ${RUN}` } }));
const balance = () => system(() => reserveBalance(app.prisma, COUNTRY));
const code = async (p: Promise<unknown>) => p.then(() => 'OK').catch((e: { code?: string }) => e.code ?? 'THREW');
const claimRow = (id: string) => system(() => app.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id } }));
const RULES = { maxHandoverDistanceKm: DEFAULT_CASH_RULES.maxHandoverDistanceKm };
const missingOf = async (claim: Parameters<typeof assembleClaimEvidence>[1]) => (await system(() => assembleClaimEvidence(app.prisma, claim, RULES))).missing;
/** A payment reference unique to this run: references are UNIQUE and PAID claims are retained. */
const ref = (label: string) => `BANK-${label}-${RUN}`;

describe('[DOC-1 P31-1] DOC-INV-47 — no loss-protection payout without a complete evidence bundle', () => {
  it('test_no_rlp_payout_without_evidence: a filing without the door photo is refused at payout, naming what is missing, even once a person approves it, and draws nothing; a URL typed into the claim later never completes it; a separately admitted filing pays', async () => {
    await fund(20_000);
    const door = await ownDoor();
    const pair = await freshPair(20, door);
    const order = await atDoorOrder({ food: 2000, pair, door });
    const { claim } = await file(order, 'no_show', { pair, door, photo: false });
    expect(claim).toMatchObject({ status: 'PENDING_REVIEW', evidenceComplete: false, flags: [LOSS_PROTECTION_FLAGS.evidenceIncomplete] });
    const bundle = await system(() => assembleClaimEvidence(app.prisma, claim!, RULES));
    expect(bundle.complete).toBe(false);
    expect(bundle.missing).toEqual(['door_photo']);
    // Approval is a person's decision, not evidence.
    await system(() => cash.approveClaim(claim!.id, 'admin-review', 'approved without the door photo'));
    const before = await balance();
    await expect(system(() => cash.markClaimPaid(claim!.id, 'admin-pay', ref('RLP1'), 2000))).rejects.toMatchObject({ code: 'RLP_EVIDENCE_INCOMPLETE' });
    expect((await claimRow(claim!.id)).status).toBe('APPROVED');
    expect(await balance()).toBe(before); // nothing was drawn for a refused payout
    // A URL written onto the claim afterwards is a declaration: it cannot repair the filing.
    await system(() => app.prisma.reimbursementClaim.update({ where: { id: claim!.id }, data: { photoUrl: 'https://cdn.test/door.jpg' } }));
    await expect(system(() => cash.markClaimPaid(claim!.id, 'admin-pay', ref('RLP1'), 2000))).rejects.toMatchObject({ code: 'RLP_EVIDENCE_INCOMPLETE' });
    expect(await balance()).toBe(before);
    // The positive case is a separate filing the platform admits on its own evidence.
    const door2 = await ownDoor();
    const pair2 = await freshPair(22, door2);
    const order2 = await atDoorOrder({ food: 2000, pair: pair2, door: door2 });
    const admitted = (await file(order2, 'no_show', { pair: pair2, door: door2 })).claim!;
    expect(admitted).toMatchObject({ status: 'AUTO_APPROVED', evidenceComplete: true, flags: [] });
    const paid = await system(() => cash.markClaimPaid(admitted.id, 'admin-pay', ref('RLP2'), 2000));
    expect(paid.status).toBe('PAID');
    expect(await balance()).toBe(before - 2000);
    const draw = await system(() => app.prisma.rlpReserveEntry.findUnique({ where: { claimId: admitted.id } }));
    expect(draw).toMatchObject({ kind: 'PAYOUT', countryCode: COUNTRY });
    expect(Number(draw!.amount)).toBe(-2000);
  });

  it('the bundle is assembled from artefacts, never typed: a planted claim stays incomplete whatever it declares; no arrival refuses the no-show; no pickup, an empty cart, a distant or stale server fix, or a photo the server never issued each leave a real filing incomplete', async () => {
    // History only: a claim planted without a filing declares GPS at the door and a photo, and proves nothing.
    const legacy = await atDoorOrder({ food: 1500 });
    const planted = await plantClaim(legacy.id, 1500, { photoUrl: 'https://cdn.test/legacy.jpg' });
    const plantedBundle = await system(() => assembleClaimEvidence(app.prisma, planted, RULES));
    expect(plantedBundle.complete).toBe(false);
    expect(plantedBundle.missing).toEqual(expect.arrayContaining(['handover_not_completed', 'rider_at_door', 'elapsed_wait', 'door_photo']));
    // No arrival: the canonical no-show refusal, and nothing is filed.
    const noArrival = await atDoorOrder({ food: 1500, arrived: false });
    await expect(file(noArrival, 'no_show', { photo: false })).rejects.toMatchObject({ code: 'NO_SHOW_NOT_ARRIVED' });
    expect(await system(() => app.prisma.cashHandoverEvidence.count({ where: { orderId: noArrival.id } }))).toBe(0);
    expect(await system(() => app.prisma.reimbursementClaim.count({ where: { orderId: noArrival.id } }))).toBe(0);
    const noPickup = await atDoorOrder({ food: 1500, pickedUp: false });
    expect(await missingOf((await file(noPickup, 'no_show')).claim!)).toEqual(['pickup_proof']);
    const noCart = await atDoorOrder({ food: 1500, cart: false });
    expect(await missingOf((await file(noCart, 'no_show')).claim!)).toEqual(['cart_snapshot']);
    // The GPS typed at the door cannot stand in for the fix the session persisted.
    const farAway = await atDoorOrder({ food: 1500 });
    const farClaim = (await file(farAway, 'no_show', { fixAt: { lat: DOOR.lat + 0.05, lng: DOOR.lng } })).claim!;
    const far = await system(() => assembleClaimEvidence(app.prisma, farClaim, RULES));
    expect(far.missing).toEqual(['rider_at_door']);
    expect(far.items.find((i) => i.key === 'rider_at_door')?.detail?.['distanceKm']).toBeGreaterThan(0.75);
    const stale = await atDoorOrder({ food: 1500 });
    expect(await missingOf((await file(stale, 'no_show', { fixAgeMs: NO_SHOW_EVIDENCE_MAX_AGE_MS + 60_000 })).claim!)).toEqual(['rider_at_door']);
    // [register row 124] A refusal filed with a photo the server issued but no fresh fix of the rider's own at the
    // door strikes nobody: a photo alone is not evidence that the customer refused. Nor do the no-shows above.
    const photoOnly = await atDoorOrder({ food: 1500 });
    expect(await missingOf((await file(photoOnly, 'refused', { fixAgeMs: NO_SHOW_EVIDENCE_MAX_AGE_MS + 60_000 })).claim!)).toEqual(['rider_at_door']);
    expect(await system(() => app.prisma.strike.count({ where: { orderId: { in: [photoOnly.id, farAway.id, stale.id] } } }))).toBe(0);
    // A photo URL the server never issued is a declaration too.
    const typedPhoto = await atDoorOrder({ food: 1500 });
    expect(await missingOf((await file(typedPhoto, 'no_show', { photo: 'https://cdn.test/typed.jpg' })).claim!)).toEqual(['door_photo']);
    // Contact attempts are reported, never required, until a call artefact exists.
    expect(far.items.find((i) => i.key === 'customer_contacted')).toMatchObject({ required: false, present: false });
  });
});

describe('[DOC-1 P31-1] the policy: covered amount, caps, review threshold, suspension', () => {
  it('a real no-show at the door covers the FOOD COST the rider fronted, not the order total; the claim carries its bundle and is auto-approved when clean', async () => {
    const door = await ownDoor();
    const pair = await freshPair(10, door);
    const order = await atDoorOrder({ food: 3000, fee: 800, pair, door });
    const claim = (await file(order, 'no_show', { pair, door })).claim!;
    expect(Number(claim.amount)).toBe(3000);
    expect(claim.evidenceComplete).toBe(true);
    expect(claim.status).toBe('AUTO_APPROVED');
    expect(claim.flags).toEqual([]);
    expect((claim.evidence as { rail: string }).rail).toBe('DELIVERY');
    // A complete filing strikes, and the dispute trail must not say otherwise.
    expect(await system(() => app.prisma.strike.count({ where: { orderId: order.id, userId: pair.customerId } }))).toBe(1);
    const failedNote = (await system(() => app.prisma.orderStatusLog.findFirst({ where: { orderId: order.id, status: 'FAILED' }, select: { note: true } })))?.note;
    expect(failedNote).toContain('evidence:');
    expect(failedNote, 'the FAILED note must not claim a strike was withheld when one was recorded').not.toContain('withheld');
  });

  it('the cap per claim is the ID gate measured on the fronted cost: food just under the gate is covered even when the fee lifts the total over it', async () => {
    const food = Math.floor(gateLocal) - 100;
    const door = await ownDoor();
    const pair = await freshPair(12, door);
    const order = await atDoorOrder({ food, fee: 2000, pair, door });
    const result = await file(order, 'no_show', { pair, door });
    expect(result.claim).not.toBeNull();
    expect(Number(result.claim!.amount)).toBe(food);
    // Above the review threshold: a person decides, with the bundle (complete here, so the threshold alone routes it).
    expect(result.claim!.evidenceComplete).toBe(true);
    expect(result.claim!.flags).toEqual([LOSS_PROTECTION_FLAGS.overReviewThreshold]);
    expect(result.claim!.status).toBe('PENDING_REVIEW');
  });

  it('the rolling 30-day cap per rider: claims inside the window count, older ones do not', async () => {
    const cap = gateLocal * LOSS_PROTECTION_DEFAULTS.rlpMonthlyCapMultiple;
    const slice = Math.floor(cap / 3) + 1; // three of these breach the cap; two do not — and each is well below the gate
    expect(slice).toBeLessThan(gateLocal);
    const door = await ownDoor();
    const pair = await freshPair(14, door);
    // History: claims planted without a filing count toward the rolling total exactly as they always did.
    const plant = (orderId: string, extra: Record<string, unknown>) => plantClaim(orderId, slice, { riderId: pair.riderId, customerId: pair.customerId, gpsLat: door.lat, gpsLng: door.lng, ...extra });
    const old = await atDoorOrder({ food: slice, pair, door });
    await plant(old.id, { photoUrl: 'https://cdn.test/old.jpg', status: 'PAID', createdAt: new Date(Date.now() - 31 * 24 * HOUR) });
    const recent = await atDoorOrder({ food: slice, pair, door });
    await plant(recent.id, { photoUrl: 'https://cdn.test/recent.jpg', status: 'PAID', createdAt: new Date(Date.now() - 5 * 24 * HOUR) });
    const recent2 = await atDoorOrder({ food: slice, pair, door });
    await plant(recent2.id, { photoUrl: 'https://cdn.test/recent2.jpg', status: 'APPROVED', createdAt: new Date(Date.now() - 3 * 24 * HOUR) });
    const order = await atDoorOrder({ food: slice, pair, door });
    const result = await file(order, 'no_show', { pair, door });
    expect(result.claim!.evidenceComplete).toBe(true);
    expect(result.claim!.flags).toContain(LOSS_PROTECTION_FLAGS.overMonthlyCap); // recent + recent2 + this one > cap; the old one is outside the window
    expect(result.claim!.status).toBe('PENDING_REVIEW');
    // Move one recent claim out of the window: a further small claim now passes the cap.
    await system(() => app.prisma.reimbursementClaim.updateMany({ where: { orderId: { in: [recent.id, recent2.id] } }, data: { createdAt: new Date(Date.now() - 31 * 24 * HOUR) } }));
    const again = await atDoorOrder({ food: 1000, pair, door });
    const clean = await file(again, 'no_show', { pair, door });
    expect(clean.claim!.flags).not.toContain(LOSS_PROTECTION_FLAGS.overMonthlyCap);
  });

  it('suspension is stated and told, never silent: the mover is notified, a new claim goes to review, an AUTO_APPROVED claim cannot be paid until a person approves it, and reinstatement is told too', async () => {
    await fund(10_000);
    // An AUTO_APPROVED claim the platform would pay: a real filing by a clean pair, before the suspension.
    const door = await ownDoor();
    const pair = await freshPair(16, door);
    const earlier = await atDoorOrder({ food: 1200, pair, door });
    const autoApproved = (await file(earlier, 'no_show', { pair, door })).claim!;
    expect(autoApproved).toMatchObject({ status: 'AUTO_APPROVED', evidenceComplete: true });
    const facts: Record<string, unknown>[] = [];
    await system(() => cash.suspendLossProtection(pair.riderUserId, 'confirmed collusion finding — case 42', async (_tx, f) => { facts.push(f); }));
    // [C-01b] The facts no longer carry `reason`, and must not: `reason` is a
    // CANONICAL column of the audit row, and `adminAuditRow` refuses an extra
    // that redefines one — which made every call to
    // PUT /cash-rules/rlp/movers/:userId/suspend a 500 on main. Nothing caught
    // it because this test calls the SERVICE with its own stub callback, which
    // is precisely the shape that hid it.
    //
    // [review] The previous version of this comment said the stated reason was
    // "now asserted through the real route" — it was NOT. The only route-level
    // reason assertion covered /reinstate, a DIFFERENT route that never carried
    // the override, so coverage was removed on a justification that did not
    // exist. It exists now: admin-audit-unique-selector.test.ts asserts
    // changes.reason on THIS route (and on the doc-type route), with a body
    // reason deliberately different from the header so precedence is
    // observable. Here we assert the fact the service genuinely owns — what it
    // persisted.
    expect(facts[0]).toMatchObject({ suspendedReason: 'confirmed collusion finding — case 42' });
    expect(facts[0]).toHaveProperty('lossProtectionSuspendedAt');
    expect(facts[0], 'a canonical name in the facts is refused at the audit row').not.toHaveProperty('reason');
    const told = await system(() => app.prisma.notification.findFirst({ where: { userId: pair.riderUserId, data: { path: ['kind'], equals: 'rlp_suspended' } } }));
    expect(told).not.toBeNull();
    const door2 = await ownDoor();
    const order = await atDoorOrder({ food: 1000, pair, door: door2 });
    const result = await file(order, 'no_show', { pair, door: door2 });
    expect(result.claim!.evidenceComplete).toBe(true);
    expect(result.claim!.flags).toContain(LOSS_PROTECTION_FLAGS.protectionSuspended);
    expect(result.claim!.status).toBe('PENDING_REVIEW');
    const notice = await system(() => app.prisma.notification.findFirst({ where: { userId: pair.riderUserId, data: { path: ['claimId'], equals: result.claim!.id } }, select: { body: true } }));
    expect(notice?.body).toContain('suspended');
    expect(await code(system(() => cash.markClaimPaid(autoApproved.id, 'admin-pay', ref('SUSP1'), 1200)))).toBe('RLP_PROTECTION_SUSPENDED');
    expect((await claimRow(autoApproved.id)).status).toBe('AUTO_APPROVED');
    // A person approves the reviewed claim — that is the human-review route — and the payout is allowed.
    await system(() => cash.approveClaim(result.claim!.id, 'admin-review', 'reviewed with the bundle'));
    const paid = await system(() => cash.markClaimPaid(result.claim!.id, 'admin-pay', ref('SUSP2'), 1000));
    expect(paid.status).toBe('PAID');
    await system(() => cash.reinstateLossProtection(pair.riderUserId, 'appeal upheld'));
    expect(await system(() => app.prisma.notification.count({ where: { userId: pair.riderUserId, data: { path: ['kind'], equals: 'rlp_reinstated' } } }))).toBe(1);
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: pair.riderUserId }, select: { lossProtectionSuspendedAt: true } }))).lossProtectionSuspendedAt).toBeNull();
    const now = await system(() => cash.markClaimPaid(autoApproved.id, 'admin-pay', ref('SUSP3'), 1200));
    expect(now.status).toBe('PAID');
  });
});

describe('[DOC-1 P31-1] the reserve: a named, funded line — paid from it or not at all', () => {
  it('an empty or short reserve refuses the payout with the shortfall; the claim stays approved; funding it pays; the ledger entry names the claim', async () => {
    // A payable claim: a real filing the platform admits on its own evidence.
    const door = await ownDoor();
    const pair = await freshPair(30, door);
    const order = await atDoorOrder({ food: 2500, pair, door });
    const claim = (await file(order, 'no_show', { pair, door })).claim!;
    expect(claim).toMatchObject({ status: 'AUTO_APPROVED', evidenceComplete: true });
    // Empty the line from a snapshot taken here: earlier suites and runs leave their own balance.
    const start = await balance();
    if (start > 0) await fund(-start);
    expect(await balance()).toBe(0);
    await expect(system(() => cash.markClaimPaid(claim.id, 'admin-pay', ref('RES1'), 2500))).rejects.toMatchObject({ code: 'RLP_RESERVE_UNFUNDED' });
    expect((await claimRow(claim.id)).status).toBe('AUTO_APPROVED');
    expect((await claimRow(claim.id)).paymentRef).toBeNull();
    await fund(2000); // still short by 500
    await expect(system(() => cash.markClaimPaid(claim.id, 'admin-pay', ref('RES1'), 2500))).rejects.toMatchObject({ code: 'RLP_RESERVE_UNFUNDED' });
    await fund(500);
    const paid = await system(() => cash.markClaimPaid(claim.id, 'admin-pay', ref('RES1'), 2500));
    expect(paid.status).toBe('PAID');
    expect(await balance()).toBe(0);
    const draw = await system(() => app.prisma.rlpReserveEntry.findUnique({ where: { claimId: claim.id } }));
    expect(draw).toMatchObject({ kind: 'PAYOUT', countryCode: COUNTRY });
  });

  it('the database is the backstop: a raw entry that would take the line below zero is refused by the trigger, and the migration carries the trigger verbatim', async () => {
    const before = await balance();
    await expect(system(() => app.prisma.rlpReserveEntry.create({ data: { countryCode: COUNTRY, kind: 'PAYOUT', amount: -(before + 1), note: `fixture ${RUN} raw` } }))).rejects.toThrow(/RLP_RESERVE_UNFUNDED/);
    expect(await balance()).toBe(before);
    const migration = readFileSync(join(__dirname, '..', '..', 'prisma', 'migrations', '20260906130000_rlp_reserve', 'migration.sql'), 'utf8');
    expect(migration).toContain(rlpReserveDdl());
  });

  it('the manual entry is audited with the resulting balance and cannot overdraw either', async () => {
    const facts: Record<string, unknown>[] = [];
    const entry = await system(() => cash.adjustLossProtectionReserve(COUNTRY, 700, 'admin-fin', `fixture ${RUN} top-up`, async (_tx, f) => { facts.push(f); }));
    expect(facts[0]).toMatchObject({ countryCode: COUNTRY, amount: 700, reserveBalanceAfter: entry.balanceAfter });
    await expect(system(() => cash.adjustLossProtectionReserve(COUNTRY, -(entry.balanceAfter + 1), 'admin-fin', `fixture ${RUN} bad`))).rejects.toMatchObject({ code: 'RLP_RESERVE_UNFUNDED' });
    await expect(system(() => cash.adjustLossProtectionReserve(COUNTRY, 0, 'admin-fin', `fixture ${RUN} zero`))).rejects.toMatchObject({ code: 'RLP_AMOUNT_INVALID' });
    const statement = await system(() => cash.lossProtectionReserve(COUNTRY));
    expect(statement.balance).toBe(entry.balanceAfter);
    expect(statement.floor).toBe(gateLocal * LOSS_PROTECTION_DEFAULTS.rlpReserveFloorMultiple);
    expect(statement.entries[0]).toMatchObject({ kind: 'ADJUSTMENT', amount: '700' });
  });

  it('monthly provisioning: the previous month\'s PAID fee revenue times the rate, once per country per month — a replay adds nothing', async () => {
    // [SAFE-B · retained history] A PROVISION entry is a money record and is never deleted, so each run
    // provisions a month this database has never provisioned: the first free April from 2031 onward.
    let year = 2031;
    const provisioned = async (y: number) => system(() => app.prisma.rlpReserveEntry.count({ where: { countryCode: COUNTRY, kind: 'PROVISION', periodKey: `${y}-03` } }));
    while (await provisioned(year) > 0) year += 1;
    const periodKey = `${year}-03`;
    const period = new Date(Date.UTC(year, 3, 1)); // a provisioning run on <year>-04-01 covers <year>-03
    const sub = await system(() => app.prisma.subscription.create({ data: { riderId, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 12000, currentPeriodStart: new Date(Date.UTC(year, 2, 1)), currentPeriodEnd: new Date(Date.UTC(year, 2, 8)), nextBillingDate: new Date(Date.UTC(year, 2, 8)) } as never }));
    try {
      await system(() => app.prisma.subscriptionPayment.createMany({ data: [
        { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(year, 2, 1)), periodEnd: new Date(Date.UTC(year, 2, 8)), paidAt: new Date(Date.UTC(year, 2, 3)) },
        { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(year, 2, 8)), periodEnd: new Date(Date.UTC(year, 2, 15)), paidAt: new Date(Date.UTC(year, 2, 10)) },
        { subscriptionId: sub.id, amount: 12000, status: 'FAILED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(year, 2, 15)), periodEnd: new Date(Date.UTC(year, 2, 22)), paidAt: null },
        { subscriptionId: sub.id, amount: 12000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(Date.UTC(year, 3, 1)), periodEnd: new Date(Date.UTC(year, 3, 8)), paidAt: new Date(Date.UTC(year, 3, 2)) },
      ] as never }));
      const before = await balance();
      const rulesFor = async () => ({ ...LOSS_PROTECTION_DEFAULTS, rlpReserveRatePct: 2 });
      const first = await system(() => provisionReserveForPreviousMonth(app.prisma, { now: period, rulesFor, notifications }));
      const mine = first.find((r) => r.countryCode === COUNTRY);
      expect(mine).toMatchObject({ periodKey, created: true });
      expect(mine!.revenue).toBeGreaterThanOrEqual(24000); // the two PAID March payments; April and the failed one excluded
      expect(mine!.provisioned).toBe(Math.round(mine!.revenue * 2) / 100);
      expect(await balance()).toBe(before + mine!.provisioned);
      expect(await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_reserve_provisioned' } } }))).toBeGreaterThanOrEqual(1);
      const replay = await system(() => provisionReserveForPreviousMonth(app.prisma, { now: period, rulesFor }));
      expect(replay.find((r) => r.countryCode === COUNTRY)?.created).toBe(false);
      expect(await balance()).toBe(before + mine!.provisioned);
    } finally {
      // The subscription is billing scaffolding, not evidence; its future-dated billing must not reach another suite's cycle.
      await system(() => app.prisma.subscription.delete({ where: { id: sub.id } }));
    }
  });

  it('the daily sweep flags an approved claim unpaid past the SLA once, tells the admins once a day, and names a reserve below its floor', async () => {
    // The floor finding is about the line as it stands: bring it below the floor from a snapshot taken here.
    const floor = gateLocal * LOSS_PROTECTION_DEFAULTS.rlpReserveFloorMultiple;
    const start = await balance();
    if (start >= floor) await fund(-(start - floor + 1));
    expect(await balance()).toBeLessThan(floor);
    const stale = await atDoorOrder({ food: 900 });
    const claim = await plantClaim(stale.id, 900, { photoUrl: 'https://cdn.test/stale.jpg', createdAt: new Date(Date.now() - (LOSS_PROTECTION_DEFAULTS.rlpSlaHours + 2) * HOUR) });
    const fresh = await atDoorOrder({ food: 900 });
    const young = await plantClaim(fresh.id, 900, { photoUrl: 'https://cdn.test/fresh.jpg' });
    const rulesFor = async () => LOSS_PROTECTION_DEFAULTS;
    const gateFor = async () => gateLocal;
    const noticesBefore = await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_sla_breached' } } }));
    const run = await system(() => sweepLossProtection(app.prisma, { notifications, rulesFor, gateFor }));
    expect(run.breached.some((b) => b.claimId === claim.id)).toBe(true);
    expect(run.breached.some((b) => b.claimId === young.id)).toBe(false);
    expect((await claimRow(claim.id)).flags).toContain(LOSS_PROTECTION_FLAGS.slaBreached);
    expect((await claimRow(claim.id)).status).toBe('AUTO_APPROVED'); // the sweep pays nothing and moves nothing
    expect(run.lowReserve.find((l) => l.countryCode === COUNTRY)).toMatchObject({ floor: gateLocal * LOSS_PROTECTION_DEFAULTS.rlpReserveFloorMultiple });
    const noticesAfter = await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_sla_breached' } } }));
    expect(noticesAfter).toBeGreaterThanOrEqual(noticesBefore);
    const again = await system(() => sweepLossProtection(app.prisma, { notifications, rulesFor, gateFor }));
    expect(again.newlyFlagged).toBe(0);
    expect((await claimRow(claim.id)).flags.filter((f) => f === LOSS_PROTECTION_FLAGS.slaBreached)).toHaveLength(1);
    expect(await system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'rlp_sla_breached' } } }))).toBe(noticesAfter);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'RLP_SWEEP', entityId: `daily:${new Date().toISOString().slice(0, 10)}` } }))).toBeGreaterThanOrEqual(2);
  });
});
