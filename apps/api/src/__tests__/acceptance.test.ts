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
const PHONES = ['+5920009811', '+5920009812', '+5920009813'];
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

  // 2. Float gate — KNOWN GAP (spec D.3 / Phase 1). Expected-fail until step 1.3 wires it.
  it.todo('2. a rider whose availableFloat < cashToRestaurant is NOT offered the order — float gate (D.3, not built yet)');

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
