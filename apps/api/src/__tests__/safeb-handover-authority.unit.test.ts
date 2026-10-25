import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type {} from '@fastify/multipart';
import type {} from '@fastify/rate-limit';
import { CashRulesService } from '../modules/cash/cash-rules.service';
import { admittedCourierPhoto, captureHandoverEvidence, handoverBinding, issueHandoverPhoto } from '../modules/cash/handover-evidence';
import { assembleClaimEvidence } from '../modules/cash/rlp';
import { CountryConfigService } from '../modules/country/country-config.service';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Persistence and external effects are synthetic. The route, handover policy,
// evidence assembler, claim transition and reserve draw are real production code.
// These tests do not assert database concurrency or transport authentication.
const DOOR = { lat: 6.81, lng: -58.16 };
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const order: any = {
    id: 'safeb-order', tenantId: 'safeb-tenant', orderType: 'TAXI',
    driverId: 'safeb-driver', riderId: null, customerId: 'safeb-customer',
    status: 'RIDE_IN_PROGRESS', paymentMethod: 'CASH', paymentStatus: 'PENDING',
    deliveryLat: DOOR.lat, deliveryLng: DOOR.lng, deliveredAt: null,
    pickedUpAt: new Date(Date.now() - 12 * 60_000), taxiDuration: 10,
    totalAmount: 1000, subtotalBase: 800, _count: { items: 1 },
    customer: { id: 'safeb-customer', phone: '+5920000000', countryCode: 'GY' },
  };
  const driver = {
    id: 'safeb-driver', userId: 'safeb-driver-user', tenantId: 'safeb-tenant', locationSessionId: 'safeb-session',
    currentLat: 7.5, currentLng: -58.5, lastLocationUpdate: new Date(Date.now() - 3_600_000),
  };
  const state = {
    order, driver, claim: null as any, strikes: [] as any[], reserve: 10_000,
    proofs: [] as any[], filings: [] as any[],
    draws: [] as any[], beforeTransaction: undefined as undefined | (() => void),
  };
  const db: any = {
    driver: {
      findUnique: vi.fn(async () => driver), findUniqueOrThrow: vi.fn(async () => driver),
    },
    rider: { findUnique: vi.fn(async () => order.riderId ? { ...driver, id: order.riderId } : null), findUniqueOrThrow: vi.fn(async () => ({ ...driver, id: order.riderId })) },
    user: { findUnique: vi.fn(async () => ({ lossProtectionSuspendedAt: null })) },
    session: { findFirst: vi.fn(async () => ({ id: 'safeb-session' })) },
    identityClusterMember: { findUnique: vi.fn(async () => null) },
    order: {
      findFirst: vi.fn(async ({ where }: any) => (
        where.id === order.id && (!where.driverId || where.driverId === order.driverId) ? { ...order } : null
      )),
      findUnique: vi.fn(async () => ({ ...order })),
      findUniqueOrThrow: vi.fn(async () => ({ ...order })),
      update: vi.fn(async ({ data }: any) => Object.assign(order, data)),
    },
    orderStatusLog: {
      findFirst: vi.fn(async () => ({ id: 'safeb-arrival', createdAt: new Date(Date.now() - 10 * 60_000) })),
      findUnique: vi.fn(async () => ({ id: 'safeb-arrival', orderId: order.id, status: 'ARRIVED', createdAt: state.filings[0]?.arrivalAt })),
      findMany: vi.fn(async () => [
        { status: 'PICKED_UP', createdAt: new Date(Date.now() - 20 * 60_000) },
        { status: 'ARRIVED', createdAt: new Date(Date.now() - 10 * 60_000) },
      ]),
    },
    chatMessage: { count: vi.fn(async () => 0) },
    strike: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => { state.strikes.push(data); return data; }),
    },
    reimbursementClaim: {
      count: vi.fn(async () => 0), findMany: vi.fn(async () => []),
      aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })),
      create: vi.fn(async ({ data }: any) => { state.claim = { id: 'safeb-claim', ...data }; return state.claim; }),
      findUnique: vi.fn(async () => state.claim ? { ...state.claim } : null),
      findUniqueOrThrow: vi.fn(async () => ({ ...state.claim })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (!state.claim || !where.status.in.includes(state.claim.status)) return { count: 0 };
        Object.assign(state.claim, data);
        return { count: 1 };
      }),
    },
    rlpReserveEntry: {
      aggregate: vi.fn(async () => ({ _sum: { amount: state.reserve } })),
      create: vi.fn(async ({ data }: any) => {
        state.reserve += data.amount; state.draws.push(data); return data;
      }),
    },
    cashHandoverEvidence: {
      create: vi.fn(async ({ data }: any) => { const row = { id: 'safeb-filing', ...data }; state.filings.push(row); return row; }),
      findUnique: vi.fn(async ({ where }: any) => state.filings.find(e => e.id === where.id) ?? null),
    },
    handoverPhotoProof: {
      create: vi.fn(async ({ data }: any) => { const row = { id: 'safeb-proof', issuedAt: new Date(), ...data }; state.proofs.push(row); return row; }),
      findUnique: vi.fn(async ({ where }: any) => state.proofs.find(p => where.id ? p.id === where.id : p.objectKey === where.objectKey) ?? null),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: any) => { state.beforeTransaction?.(); return fn(db); }),
  };
  vi.spyOn(CountryConfigService.prototype, 'getByCode').mockResolvedValue({ cashRules: {} } as never);
  vi.spyOn(CountryConfigService.prototype, 'getIdGateThresholdLocal').mockResolvedValue(10_000);
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);
  vi.spyOn(OrderService.prototype, 'updateStatus').mockImplementation(async (_id, status, _user, _note, options) => {
    const source = { ...order };
    order.status = status;
    await options?.withinTransaction?.(db, source);
    return { ...order };
  });
  const io = { to: () => ({ emit: vi.fn() }), emit: vi.fn() };
  const prisma = db as PrismaClient;
  const cash = new CashRulesService(prisma, new NotificationService(prisma, io as never), new OrderService(prisma, io as never));
  function plantClaim(photoUrl: string | null = null) {
    order.status = 'FAILED'; order.paymentStatus = 'FAILED';
    state.claim = {
      id: 'safeb-claim', orderId: order.id, riderId: null, driverId: driver.id,
      customerId: order.customerId, amount: 1000, status: 'AUTO_APPROVED', reason: 'refused',
      gpsLat: DOOR.lat, gpsLng: DOOR.lng, photoUrl, createdAt: new Date(), reviewedBy: null,
    };
    return state.claim;
  }
  async function admittedClaim(orderType = 'FOOD_DELIVERY', outcome: 'refused' | 'no_show' = 'refused') {
    order.orderType = orderType;
    order.status = orderType === 'TAXI' ? 'RIDE_IN_PROGRESS' : 'ARRIVED';
    order.driverId = orderType === 'TAXI' ? driver.id : null;
    order.riderId = orderType === 'TAXI' ? null : 'safeb-rider';
    order.courierPayer = orderType === 'COURIER' ? 'RECIPIENT' : null;
    Object.assign(driver, { currentLat: DOOR.lat, currentLng: DOOR.lng, lastLocationUpdate: new Date() });
    const storage = { upload: vi.fn(async () => ({ url: 'synthetic-issued-photo' })) };
    const proof = await issueHandoverPhoto(db, storage as never, { orderId: order.id, actorId: driver.userId,
      role: orderType === 'TAXI' ? 'DRIVER' : 'RIDER', buffer: Buffer.from([255,216,255,217,0,0,0,0,0,0,0,0]), mimeType: 'image/jpeg' });
    const filing = await captureHandoverEvidence(db, order, { actorId: driver.userId, sessionId: 'safeb-session', outcome, gps: DOOR, photoUrl: proof.url }, 0.75);
    const claim = plantClaim(proof.url);
    Object.assign(claim, { riderId: order.riderId, driverId: order.driverId, handoverEvidenceId: filing.id, reason: outcome });
    return claim;
  }
  return { db, state, cash, io, plantClaim, admittedClaim };
}

describe('failed handover needs authoritative evidence', () => {
  it.each(['refused', 'no_show'] as const)('driver route records %s for review without striking on weak evidence', async (outcome) => {
    const h = fixture();
    const app = Fastify();
    app.decorate('prisma', h.db);
    app.decorate('io', h.io as never);
    app.decorate('redis', {} as never);
    app.decorate('authenticate', async (request: any) => { request.user = { userId: h.state.driver.userId, role: 'DRIVER' }; });
    registerErrorHandler(app);
    try {
      await app.register(driverRoutes, { prefix: '/driver' });
      const result = await app.inject({ method: 'POST', url: `/driver/rides/${h.state.order.id}/handover`, payload: { outcome, gps: DOOR } });
      expect(result.statusCode, result.body).toBe(200);
      expect(h.db.reimbursementClaim.create).toHaveBeenCalledOnce();
      expect(h.state.order.status).toBe('FAILED');
      expect.soft(h.state.strikes).toHaveLength(0);
      expect.soft(h.state.claim.status).toBe('PENDING_REVIEW');
      expect.soft(h.state.claim.evidenceComplete).toBe(false);
    } finally { await app.close(); }
  });

  it.each(['TAXI', 'COURIER', 'FOOD_DELIVERY', 'GROCERY_DELIVERY'])('%s: typed destination GPS and an unissued URL are insufficient', async (orderType) => {
    const h = fixture();
    h.state.order.orderType = orderType;
    const claim = h.plantClaim('https://example.invalid/arbitrary-photo.jpg');
    const bundle = await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 });
    expect(h.db.order.findUnique).toHaveBeenCalledOnce();
    expect(bundle.complete).toBe(false);
  });

  it.each([null, 'https://example.invalid/other-order-photo.jpg'])('funded payout refuses typed GPS with photo %s', async (photo) => {
    const h = fixture();
    h.plantClaim(photo);
    const result = await h.cash.markClaimPaid('safeb-claim', 'safeb-admin', 'SYNTHETIC-TRANSFER-0001', 1000)
      .then(() => 'PAID', (err: { code: string }) => err.code);
    expect.soft(result).toBe('RLP_EVIDENCE_INCOMPLETE');
    expect.soft(h.state.draws).toHaveLength(0);
    expect.soft(h.state.reserve).toBe(10_000);
    expect.soft(h.state.claim.status).toBe('AUTO_APPROVED');
  });

  it('rechecks changed completion evidence within the payout transaction', async () => {
    const h = fixture();
    // Begin with a complete server-issued bundle: an early weak-evidence
    // refusal must not masquerade as a payout race check.
    const claim = await h.admittedClaim();
    expect((await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 })).complete).toBe(true);
    const changed = vi.fn(() => {
      h.state.order.status = 'DELIVERED';
      h.state.order.deliveredAt = new Date();
    });
    h.state.beforeTransaction = changed;
    const result = await h.cash.markClaimPaid('safeb-claim', 'safeb-admin', 'SYNTHETIC-TRANSFER-0002', 1000)
      .then(() => 'PAID', (err: { code: string }) => err.code);
    expect(changed).toHaveBeenCalledOnce();
    expect.soft(result).toBe('RLP_EVIDENCE_INCOMPLETE');
    expect.soft(h.state.draws).toHaveLength(0);
  });
});


describe('server admitted handover proof', () => {
  it.each(['FOOD_DELIVERY', 'GROCERY_DELIVERY', 'COURIER'])('%s admits an issued bound artifact and funded payout', async (rail) => {
    const h = fixture(); const claim = await h.admittedClaim(rail);
    expect((await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 })).complete).toBe(true);
    await h.cash.markClaimPaid(claim.id, 'safeb-admin', 'SYNTHETIC-TRANSFER-VALID', 1000);
    expect(h.state.draws).toHaveLength(1); expect(h.state.reserve).toBe(9000);
    expect(h.state.claim.status).toBe('PAID');
  });
  it('taxi with accepted photo/proximity still awaits owner destination wait policy', async () => {
    const h = fixture(); const claim = await h.admittedClaim('TAXI');
    const bundle = await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 });
    expect(bundle.missing).toEqual(['elapsed_wait']);
    await expect(h.cash.markClaimPaid(claim.id, 'safeb-admin', 'SYNTHETIC-TRANSFER-TAXI', 1000)).rejects.toMatchObject({ code: 'RLP_EVIDENCE_INCOMPLETE' });
    expect(h.state.draws).toHaveLength(0);
  });
  it.each(['stale', 'future', 'distant', 'session', 'tenant', 'actor', 'destination', 'invalidated', 'delivered', 'captured'])('refuses changed %s authority at payout', async (change) => {
    const h = fixture(); const claim = await h.admittedClaim();
    const e = h.state.filings[0];
    if (change === 'stale') e.locationAt = new Date(e.filedAt.getTime() - 300001);
    if (change === 'future') e.locationAt = new Date(e.filedAt.getTime() + 1);
    if (change === 'distant') e.locationLat = 7.5;
    if (change === 'session') e.actorSessionId = 'different-session';
    if (change === 'tenant') h.state.proofs[0].tenantId = 'foreign-tenant';
    if (change === 'actor') h.state.proofs[0].actorId = 'foreign-actor';
    if (change === 'destination') h.state.order.deliveryLat = 7.4;
    if (change === 'invalidated') h.state.proofs[0].invalidatedAt = new Date();
    if (change === 'delivered') h.state.order.status = 'DELIVERED';
    if (change === 'captured') h.state.order.paymentStatus = 'CAPTURED';
    await expect(h.cash.markClaimPaid(claim.id, 'safeb-admin', 'SYNTHETIC-TRANSFER-CHANGED', 1000)).rejects.toMatchObject({ code: 'RLP_EVIDENCE_INCOMPLETE' });
    expect(h.state.draws).toHaveLength(0);
  });
  it('later location updates cannot rewrite contemporaneous filing evidence', async () => {
    const h = fixture(); const claim = await h.admittedClaim();
    h.state.driver.currentLat = 7.8; h.state.driver.lastLocationUpdate = new Date(Date.now() + 1000);
    expect((await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 })).complete).toBe(true);
  });
  it('a session revoked or expired before filing cannot supply proximity authority', async () => {
    const h = fixture(); h.db.session.findFirst.mockResolvedValue(null);
    const claim = await h.admittedClaim();
    expect(h.state.filings).toHaveLength(1);
    expect(h.state.filings[0].actorSessionId).toBeNull();
    await expect(h.cash.markClaimPaid(claim.id, 'safeb-admin', 'SYNTHETIC-EXPIRED-SESSION', 1000)).rejects.toMatchObject({ code: 'RLP_EVIDENCE_INCOMPLETE' });
    expect(h.state.draws).toHaveLength(0);
  });
  it('delivery no-show uses exact stored elapsed wait', async () => {
    const h = fixture(); const claim = await h.admittedClaim('FOOD_DELIVERY', 'no_show');
    expect((await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 })).complete).toBe(true);
    h.state.filings[0].waitedMs = 299999;
    expect((await assembleClaimEvidence(h.db, claim, { maxHandoverDistanceKm: 0.75 })).missing).toContain('elapsed_wait');
  });
  it('lost upload assignment produces no issued proof', async () => {
    const h = fixture(); const original = handoverBinding(h.state.order);
    const storage = { upload: async () => { h.state.order.driverId = 'other-driver'; return { url: 'unadmitted-photo' }; } };
    await expect(issueHandoverPhoto(h.db, storage as never, { orderId: h.state.order.id, actorId: h.state.driver.userId, role: 'DRIVER',
      buffer: Buffer.from([255,216,255,217,0,0,0,0,0,0,0,0]), mimeType: 'image/jpeg' })).rejects.toMatchObject({ code: 'HANDOVER_AUTHORITY_CHANGED' });
    expect(handoverBinding(h.state.order)).not.toBe(original); expect(h.state.proofs).toHaveLength(0);
  });
});

describe('common courier completion proof on every paid rail', () => {
  it.each(['CASH', 'MOBILE_MONEY'])('%s cannot complete using invalidated or rebound proof', async (rail) => {
    const h = fixture(); await h.admittedClaim('COURIER');
    h.state.order.status = 'ARRIVED'; h.state.order.paymentStatus = 'CAPTURED';
    // Issue anew after the payment rail is selected; binding includes the rail.
    h.state.order.paymentMethod = rail;
    h.state.proofs[0].bindingDigest = handoverBinding(h.state.order);
    expect(await admittedCourierPhoto(h.db, h.state.order, h.state.proofs[0].objectKey)).toBe(true);
    h.state.order.deliveryLat += 1;
    expect(await admittedCourierPhoto(h.db, h.state.order, h.state.proofs[0].objectKey)).toBe(false);
    h.state.order.deliveryLat -= 1;
    h.state.proofs[0].invalidatedAt = new Date();
    expect(await admittedCourierPhoto(h.db, h.state.order, h.state.proofs[0].objectKey)).toBe(false);
    expect(h.db.$queryRaw).toHaveBeenCalled();
  });
});
