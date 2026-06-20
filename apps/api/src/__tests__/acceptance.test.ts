import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { VerificationService } from '../modules/verification/verification.service';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';

// ---------------------------------------------------------------------------
// Spec §I — acceptance conformance baseline. One file maps the 8 given/when/then
// scenarios to the LIVE engine, so a regression in any core rule fails CI.
//
//   #2 (float gate) is the known gap — D.3 / Phase 1 — marked `todo` until wired.
//   The verification-driven rules (#5/#6/#8) are asserted here against the real
//   VerificationService. The threshold (#1), ghost (#3/#4) and subscription (#7)
//   scenarios drive heavier cart/order/billing fixtures and land as their own
//   micro-commits within step 0.1 (reusing the step7 / step10 / step5 patterns).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONES = ['+5920009811', '+5920009812', '+5920009813', '+5920009814', '+5920009815'];
const GY_MOVER_DOCS = ['national_id', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

let app: FastifyInstance;
let verification: VerificationService;

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { in: PHONES } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUser(phone: string) {
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Acc',
      lastName: 'Test',
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole],
      activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true,
      countryCode: 'GY',
    },
  });
}

async function approveDoc(userId: string, docType: string, extra: Record<string, unknown> = {}) {
  return app.prisma.verificationDocument.create({
    data: {
      userId,
      role: 'RIDER' as UserRole,
      docType,
      fileUrl: `key-${nanoid(8)}`,
      status: 'APPROVED',
      ...extra,
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();

  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  await purge();
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('Spec §I — acceptance conformance baseline', () => {
  // 1. Threshold gate
  it.todo('1. L1 over the ID threshold → checkout throws ID_VERIFICATION_REQUIRED (OrderService.checkout; cart fixture, step7 pattern)');

  // 2. Float gate — D.3, now LIVE. A rider without enough free float to front the
  //    order's vendor-cash must not be a dispatch candidate; a funded rider must be.
  it('2. a rider whose availableFloat < the order cash is excluded from dispatch; a funded rider is included', async () => {
    const pickup = { lat: 6.8013, lng: -58.1551 };
    const mkRider = async (phone: string, floatLimit: number, committedFloat: number) => {
      const u = await makeUser(phone);
      return app.prisma.rider.create({
        data: {
          userId: u.id,
          riderType: 'BOTH',
          vehicleType: 'MOTORCYCLE',
          isOnline: true,
          isAvailable: true,
          currentLat: pickup.lat,
          currentLng: pickup.lng,
          floatLimit,
          committedFloat,
        },
      });
    };
    const low = await mkRider(PHONES[3]!, 8000, 7000); // availableFloat = 1000
    const funded = await mkRider(PHONES[4]!, 8000, 0); // availableFloat = 8000

    // findCandidates only calls maps.etaMinutes — a tiny stub suffices.
    const maps = { etaMinutes: async (_p: unknown, pts: unknown[]) => pts.map(() => 5) };
    const dispatch = new DispatchService(
      app.prisma,
      app.redis,
      app.io,
      maps as unknown as ConstructorParameters<typeof DispatchService>[3],
    );

    // CASH order needs 5000 fronted: low rider (1000 free) excluded, funded rider (8000) in.
    const candidates = await dispatch.findCandidates(`acc-${nanoid(6)}`, pickup, 10, 'RIDER', 5000);
    const ids = candidates.map((c) => c.riderId);
    expect(ids).toContain(funded.id);
    expect(ids).not.toContain(low.id);
  });

  // 3 & 4. Ghost / no-show
  it.todo('3. sub-threshold no-show → strike + auto-approved guarantee (cashRules.handover, order in ARRIVED — step10 pattern)');
  it.todo('4. over-threshold no-show → strike + claim withheld for review (step10 pattern)');

  // 5. Verification eligibility — REAL
  it('5. a mover with the full approved checklist is allowed to operate', async () => {
    const u = await makeUser(PHONES[0]!);
    for (const docType of GY_MOVER_DOCS) await approveDoc(u.id, docType);
    const status = await verification.getLiveOperationStatus(u.id, { taxi: false });
    expect(status.allowed).toBe(true);
    expect(status.reason).toBe('ok');
  });

  // 6. Insurance-class hard-fail — REAL
  it('6. a taxi driver without HIRE-class confirmed insurance is blocked with reason "insurance"', async () => {
    const u = await makeUser(PHONES[1]!);
    // legacyVerified bypasses the base checklist so we isolate the taxi insurance gate;
    // an APPROVED vehicle_insurance with no confirmed HIRE class must still hard-fail.
    await approveDoc(u.id, 'vehicle_insurance');
    const status = await verification.getLiveOperationStatus(u.id, { taxi: true, legacyVerified: true });
    expect(status.allowed).toBe(false);
    expect(status.reason).toBe('insurance');
  });

  // 7. Subscription lapse → delist
  it.todo('7. a merchant failing dunning → subscription LAPSED + merchant delisted (SubscriptionService, step5 pattern)');

  // 8. Doc-expiry auto-suspend — REAL
  it('8. an expired approved document is auto-flipped to EXPIRED by the sweep', async () => {
    const u = await makeUser(PHONES[2]!);
    const doc = await approveDoc(u.id, 'drivers_licence', { expiresAt: new Date(Date.now() - DAY) });
    const count = await verification.expireLapsedDocuments();
    expect(count).toBeGreaterThanOrEqual(1);
    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('EXPIRED');
  });
});
