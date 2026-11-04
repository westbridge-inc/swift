import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { VehicleType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { adminRoutes } from '../modules/admin/admin.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { grantStepUp } from './helpers/step-up';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { testPhone } from './helpers/fixture-ids';
import { lockMoverFeeAuthority } from '../modules/subscription/mover-fee-authority';
import { CountryConfigService, partnerRateFor, subscriptionTiersIn } from '../modules/country/country-config.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';

// ---------------------------------------------------------------------------
// [BUG-HUNT F05 · COORD 4 Nov 2026] "Your weekly plan is for delivery work. Contact support to move it to taxi work."
// Support had no such tool: the person was stuck on the old vehicle until Swift edited the database.
//
// Support now allows ONE move, with a reason. The person makes it themselves in the app, within seven days, because the
// vehicle is theirs to name. The fee follows the existing pricing rule: to taxi work the activation re-tiers it, a rise
// over a paid week held for the 14-day notice; to delivery work a lower card rate applies at once. No money moves, a
// paid week keeps its price, and a negotiated or waived fee is left alone. Synthetic data only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const CAR = { vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2017, color: 'Grey' } };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'mover-plan-move-test');
let app: FastifyInstance;
let adminToken: string;
const users: string[] = [];
let seq = 0;

async function makeUser() {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Plan', lastName: `Mover${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: `/uploads/avatars/pm-${seq}.jpg`,
  } }));
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'plan-move', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token };
}

const send = (method: 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>, extra: Record<string, string> = {}) => app.inject({
  method, url, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...extra }, ...(payload ? { payload } : {}),
});
const become = (token: string, body: Record<string, unknown>) => send('POST', '/api/v1/partner/become', token, { role: 'MOVER', acceptAgreement: true, ...body });
const change = (token: string, body: Record<string, unknown>) => send('PUT', '/api/v1/partner/vehicle', token, body);
const allow = (userId: string, reason: string | null = TEST_ADMIN_REASON) => send('POST', `/api/v1/admin/users/${userId}/mover-plan/allow-move`, adminToken, {}, reason ? { 'x-swift-reason': reason } : {});
const plate = () => `H${String.fromCharCode(65 + (seq % 26))} ${String(1000 + (Date.now() % 8000) + seq).slice(0, 4)}`;

/** A fee on a profile, joined to the payer's one fee authority, as an activation leaves it. */
async function feeOn(owner: { riderId: string } | { driverId: string }, userId: string, type: 'DELIVERY_RIDER' | 'TAXI_DRIVER', rate: number, extra: Record<string, unknown> = {}) {
  return system(async () => {
    const sub = await app.prisma.subscription.create({ data: {
      ...owner, type, status: 'ACTIVE', weeklyRate: rate, currencyCode: 'GYD',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY), ...extra,
    } });
    const tenantId = (await app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } })).tenantId;
    await app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, { userId, tenantId }));
    return sub;
  });
}

async function taxiDriverOnAFee(extra: Record<string, unknown> = {}) {
  const u = await makeUser();
  const made = await become(u.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } });
  expect(made.statusCode, made.body).toBeLessThan(300);
  const driverId: string = made.json().data.id;
  const sub = await feeOn({ driverId }, u.userId, 'TAXI_DRIVER', 8000, extra);
  return { ...u, driverId, sub };
}

async function riderOnAFee() {
  const u = await makeUser();
  const made = await become(u.token, { vehicleType: 'MOTORCYCLE' });
  const riderId: string = made.json().data.id;
  const sub = await feeOn({ riderId }, u.userId, 'DELIVERY_RIDER', 6000);
  return { ...u, riderId, sub };
}

/** The papers a vehicle's list asks for, filed the way the review pipeline leaves them: the real gate reads them. */
async function approvePapers(userId: string, vehicleType: VehicleType) {
  for (const docType of await system(() => new CountryConfigService(app.prisma).getMoverChecklist('GY', vehicleType))) {
    await system(() => app.prisma.verificationDocument.create({ data: {
      userId, role: 'MOVER', docType, fileUrl: `/uploads/verification/plan/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'plan-test',
      reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY),
    } }));
  }
}

const billing = (subscriptionId: string) => system(() => app.prisma.billingEvent.findMany({ where: { subscriptionId, type: 'TIER_CHANGE' } }));
const authorityOf = (userId: string) => system(() => app.prisma.moverFeeAuthority.findUnique({ where: { userId } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await registerAuthRoutes(app);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('[F05] the door', () => {
  it('support allows one move, with a reason: the person is told, and the refusal stops', async () => {
    const r = await riderOnAFee();
    await grantStepUp(app, r.token);
    const stuck = await change(r.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } });
    expect(stuck.json().error.code).toBe('PLAN_ON_CURRENT_ROLE');

    const res = await allow(r.userId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await system(() => app.prisma.notification.count({ where: { userId: r.userId, title: 'You can change your vehicle now' } }))).toBe(1);
    expect(await system(() => app.prisma.auditLog.count({ where: { entityId: r.userId, action: 'ALLOW_MOVER_PLAN_MOVE' } }))).toBe(1);

    await grantStepUp(app, r.token);
    const moved = await change(r.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().data).toMatchObject({ kind: 'DRIVER', vehicleType: 'CAR' });
  });

  it('it takes a reason', async () => {
    const r = await riderOnAFee();
    expect((await allow(r.userId, null)).statusCode).toBeGreaterThanOrEqual(400);
    const row = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: r.userId } }));
    expect(row.moverPlanMoveUntil).toBeNull();
  });

  it('it is one move: going back across the plan goes back to support', async () => {
    const d = await taxiDriverOnAFee();
    await allow(d.userId);
    await grantStepUp(app, d.token);
    expect((await change(d.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(200);
    await grantStepUp(app, d.token);
    const back = await change(d.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } });
    expect(back.statusCode).toBe(409);
    expect(back.json().error.code).toBe('PLAN_ON_CURRENT_ROLE');
    expect(back.json().error.message).toContain('delivery work');
  });

  it('changing their mind before any taxi fee began needs nobody: the plan is still a delivery plan', async () => {
    const r = await riderOnAFee();
    await allow(r.userId);
    await grantStepUp(app, r.token);
    expect((await change(r.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } })).statusCode).toBe(200);
    await grantStepUp(app, r.token);
    const back = await change(r.token, { vehicleType: 'MOTORCYCLE' });
    expect(back.statusCode, back.body).toBe(200);
  });

  it('the permit runs seven days', async () => {
    const r = await riderOnAFee();
    const before = Date.now();
    await allow(r.userId);
    const until = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: r.userId } }))).moverPlanMoveUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(until).toBeLessThanOrEqual(Date.now() + 7 * DAY);
  });

  it('it lapses after a week', async () => {
    const r = await riderOnAFee();
    await allow(r.userId);
    await system(() => app.prisma.user.update({ where: { id: r.userId }, data: { moverPlanMoveUntil: new Date(Date.now() - 1000) } }));
    await grantStepUp(app, r.token);
    const res = await change(r.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } });
    expect(res.json().error.code).toBe('PLAN_ON_CURRENT_ROLE');
  });

  it('a staff account is out of reach, even with a plan on its rider profile', async () => {
    const r = await riderOnAFee();
    await system(() => app.prisma.user.update({ where: { id: r.userId }, data: { roles: ['CUSTOMER', 'ADMIN'] } }));
    const res = await allow(r.userId);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ACCOUNT');
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: r.userId } }))).moverPlanMoveUntil).toBeNull();
  });

  it('an admin cannot allow their own move', async () => {
    const r = await riderOnAFee();
    await system(() => app.prisma.user.update({ where: { id: r.userId }, data: { roles: ['CUSTOMER', 'ADMIN'], activeRole: 'ADMIN', admin: { create: { permissions: ['*'] } } } }));
    const { phone } = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: r.userId } }));
    const own: string = (await loginWithOtp(app, phone)).json().data.tokens.accessToken;
    const res = await send('POST', `/api/v1/admin/users/${r.userId}/mover-plan/allow-move`, own, {}, { 'x-swift-reason': TEST_ADMIN_REASON });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ACCOUNT');
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: r.userId } }))).moverPlanMoveUntil).toBeNull();
  });

  it('a person with no plan has nothing to move', async () => {
    const u = await makeUser();
    const res = await allow(u.userId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_PLAN_TO_MOVE');
  });

  it('a move inside the same kind of work never spends it', async () => {
    const r = await riderOnAFee();
    await allow(r.userId);
    await grantStepUp(app, r.token);
    expect((await change(r.token, { vehicleType: 'BICYCLE' })).statusCode).toBe(200);
    const row = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: r.userId } }));
    expect(row.moverPlanMoveUntil).not.toBeNull();
  });
});

describe('[F05] the fee follows the existing rule', () => {
  it('taxi to delivery: the lower card rate applies at once, recorded, and the fee is a delivery fee', async () => {
    const d = await taxiDriverOnAFee();
    await allow(d.userId);
    await grantStepUp(app, d.token);
    const moved = await change(d.token, { vehicleType: 'MOTORCYCLE' });
    expect(moved.statusCode, moved.body).toBe(200);
    const tiers = await system(() => subscriptionTiersIn(app.prisma, 'GY'));
    const card = partnerRateFor(tiers, { kind: 'RIDER', vehicleType: 'MOTORCYCLE' }).rate;
    const after = await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: d.sub.id } }));
    expect(Number(after.weeklyRate)).toBe(card);
    expect((await authorityOf(d.userId))!.feeType).toBe('DELIVERY_RIDER');
    expect(await billing(d.sub.id)).toHaveLength(1);
  });

  it('a fee already below the card stays where it is: a higher rate never applies at once', async () => {
    const d = await taxiDriverOnAFee({ weeklyRate: 2000 });
    await allow(d.userId);
    await grantStepUp(app, d.token);
    expect((await change(d.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(200);
    expect(Number((await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: d.sub.id } }))).weeklyRate)).toBe(2000);
    expect(await billing(d.sub.id)).toHaveLength(0);
    expect((await authorityOf(d.userId))!.feeType).toBe('DELIVERY_RIDER');
  });

  it('taxi to delivery with the new vehicle\'s papers complete: the fee stays a delivery fee, and a later activation leaves it', async () => {
    const d = await taxiDriverOnAFee();
    await approvePapers(d.userId, 'BICYCLE');
    await allow(d.userId);
    await grantStepUp(app, d.token);
    const moved = await change(d.token, { vehicleType: 'BICYCLE' });
    expect(moved.statusCode, moved.body).toBe(200);
    const riderId: string = moved.json().data.id;
    const tiers = await system(() => subscriptionTiersIn(app.prisma, 'GY'));
    const card = partnerRateFor(tiers, { kind: 'RIDER', vehicleType: 'BICYCLE' }).rate;
    const check = async () => {
      expect(Number((await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: d.sub.id } }))).weeklyRate)).toBe(card);
      expect((await authorityOf(d.userId))!.feeType).toBe('DELIVERY_RIDER');
      expect(await billing(d.sub.id)).toHaveLength(1);
    };
    await check();
    // What a later approval runs, and a repeat save.
    await system(() => new SubscriptionService(app.prisma).startTrialForRider(riderId));
    expect((await change(d.token, { vehicleType: 'BICYCLE' })).statusCode).toBe(200);
    await check();
  });

  it('a negotiated rate is left alone', async () => {
    const d = await taxiDriverOnAFee({ customRate: 3000 });
    await allow(d.userId);
    await grantStepUp(app, d.token);
    expect((await change(d.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(200);
    expect(Number((await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: d.sub.id } }))).weeklyRate)).toBe(8000);
    expect(await billing(d.sub.id)).toHaveLength(0);
  });

  it('a waived fee is left alone', async () => {
    const d = await taxiDriverOnAFee({ feeWaived: true });
    await allow(d.userId);
    await grantStepUp(app, d.token);
    expect((await change(d.token, { vehicleType: 'MOTORCYCLE' })).statusCode).toBe(200);
    expect(await billing(d.sub.id)).toHaveLength(0);
  });

  it('delivery to taxi changes no rate at the move: the taxi rate waits for approved taxi papers, under the 14-day rule', async () => {
    const r = await riderOnAFee();
    await allow(r.userId);
    await grantStepUp(app, r.token);
    expect((await change(r.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } })).statusCode).toBe(200);
    const after = await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: r.sub.id } }));
    expect(Number(after.weeklyRate)).toBe(6000);
    expect(await billing(r.sub.id)).toHaveLength(0);
  });

  it('once the taxi papers are approved, the existing activation prices a fee nobody has paid at the taxi rate', async () => {
    const r = await riderOnAFee();
    await allow(r.userId);
    await grantStepUp(app, r.token);
    const moved = await change(r.token, { ...CAR, vehicle: { ...CAR.vehicle, licensePlate: plate() } });
    await system(() => new SubscriptionService(app.prisma).startTrialForDriver(moved.json().data.id));
    const tiers = await system(() => subscriptionTiersIn(app.prisma, 'GY'));
    expect(Number((await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: r.sub.id } }))).weeklyRate)).toBe(partnerRateFor(tiers, { kind: 'DRIVER', vehicleType: 'CAR' }).rate);
    expect((await authorityOf(r.userId))!.feeType).toBe('TAXI_DRIVER');
  });
});
