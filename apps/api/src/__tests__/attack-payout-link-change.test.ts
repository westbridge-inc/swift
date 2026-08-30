import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { STEP_UP_TTL_S, maskPhone, stepUpCodeKey } from '../modules/auth/step-up';
import { applyDueMmgLinkChanges, sessionSignals } from '../modules/integrity/money-surface';
import { storeOtp } from '../utils/otp';

// ---------------------------------------------------------------------------
// ALG-INV-14 — `attack_payout_link_change`: the MMG pay link is hostile until
// proven. The attacker holds a VALID session on the owner's account (a stolen
// token, a SIM that answers). What must still be true:
//
//   1. no step-up, no change — 403, the link untouched;
//   2. even WITH a step-up (the attacker answers the OTP), the new link is
//      only STAGED: the old link keeps paying the owner for the cool-off;
//   3. the OLD contact point is told — SMS to the account phone, a push to
//      every device — with a cancel;
//   4. the owner's own device cancels it and every other session dies;
//   5. only an unchallenged cool-off applies the change;
//   6. a step-up is per SESSION and the step-up bucket is not the login OTP's;
//   7. every step is a decision row (ALG-34) with the measurable signals.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200665';
const DAY = 24 * 60 * 60 * 1000;
const OLD_LINK = 'https://pay.example.com/pay/honest-diner';
const NEW_LINK = 'https://pay.example.com/pay/attacker-42';

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Ato', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  return { userId: user.id, phone: user.phone };
}

/** A session on `userId` from a given device and IP — the owner's phone, or a burner. */
async function makeSession(userId: string, role: UserRole, device: { deviceId: string; ip: string }) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      authMethod: 'OTP', userId, token, refreshToken: nanoid(48), deviceId: device.deviceId, deviceType: 'test',
      ipAddress: device.ip, expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { token, sessionId: session.id };
}

async function makeVendor(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Honest Diner', slug: `honest-diner-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}90`, addressLine1: '5 Deal Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
      mmgPayUrl: OLD_LINK,
    },
  });
  return vendor.id;
}

function inject(method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown, vendorId?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

const liveLink = async (vendorId: string) =>
  (await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true } }));
const rows = (subjectId: string) => app.prisma.algoDecision.findMany({ where: { algo: 'ALG-34', subjectId }, orderBy: { createdAt: 'asc' } });
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);

/** Walk the REAL step-up: request the code, read it off the dev SMS buffer, verify it on this session.
 *  The one-send-a-minute account limit is real; the test lifts it so the walk can repeat. */
async function stepUpFor(token: string, who: { userId: string; phone: string }) {
  resetDevChannelLog();
  await app.redis.del(`otp_rate:${stepUpCodeKey(who.userId)}`);
  const sent = await inject('POST', '/api/v1/auth/step-up', token);
  expect(sent.statusCode).toBe(200);
  const sms = smsTo(who.phone).at(-1);
  expect(sms, 'the code goes to the phone on the account').toBeDefined();
  const code = /\b(\d{6})\b/.exec(sms!.body)?.[1];
  expect(code).toBeDefined();
  const ok = await inject('POST', '/api/v1/auth/step-up/verify', token, { code });
  expect(ok.statusCode).toBe(200);
  return code!;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.example.com';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  await purge();
});

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const vendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: vos.map((v) => v.id) } }, select: { id: true } });
  const drivers = await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-34', subjectId: { in: [...vendors.map((v) => v.id), ...drivers.map((d) => d.id)] } } });
  await app.prisma.vendorStaff.deleteMany({ where: { OR: [{ userId: { in: ids } }, { vendorId: { in: vendors.map((v) => v.id) } }] } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendors.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  for (const id of ids) await app.redis.del(`otp:${stepUpCodeKey(id)}`, `otp_rate:${stepUpCodeKey(id)}`, `stepup:fail:${id}`, `stepup:lock:${id}`);
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

afterAll(async () => {
  await purge();
  await app.close();
});

describe('attack_payout_link_change — the store', () => {
  let owner: { userId: string; phone: string };
  let vendorId: string;
  let ownerPhone: { token: string; sessionId: string };
  let attacker: { token: string; sessionId: string };

  beforeAll(async () => {
    owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    vendorId = await makeVendor(owner.userId);
    ownerPhone = await makeSession(owner.userId, 'VENDOR_OWNER', { deviceId: 'owner-phone', ip: '10.0.0.7' });
    attacker = await makeSession(owner.userId, 'VENDOR_OWNER', { deviceId: 'burner-android', ip: '203.0.113.9' });
  });

  it('1. a valid session without a step-up cannot move the link — 403, and the link is untouched', async () => {
    const res = await inject('PUT', '/api/v1/vendor/profile', attacker.token, { mmgPayUrl: NEW_LINK }, vendorId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');
    expect(res.json().error.details?.stepUp?.send).toBe('POST /auth/step-up');
    expect(await liveLink(vendorId)).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: null });
  });

  it('6a. the step-up round-trip: the code goes to the account phone, a wrong code is refused, the right one is per SESSION', async () => {
    resetDevChannelLog();
    const sent = await inject('POST', '/api/v1/auth/step-up', attacker.token);
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.sentTo).toBe(maskPhone(owner.phone));
    expect(sent.json().data.sentTo.endsWith(owner.phone.slice(-4))).toBe(true);
    expect(sent.json().data.sentTo).not.toContain(owner.phone.slice(4, -4));
    const sms = smsTo(owner.phone).at(-1)!;
    expect(sms.body).toMatch(/Swift will never ask you for it/);
    const code = /\b(\d{6})\b/.exec(sms.body)![1]!;

    const wrong = await inject('POST', '/api/v1/auth/step-up/verify', attacker.token, { code: code === '000000' ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_CODE');

    const ok = await inject('POST', '/api/v1/auth/step-up/verify', attacker.token, { code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.validForSeconds).toBe(STEP_UP_TTL_S);

    // The OWNER's own session did not inherit it.
    const other = await inject('PUT', '/api/v1/vendor/profile', ownerPhone.token, { mmgPayUrl: NEW_LINK }, vendorId);
    expect(other.statusCode).toBe(403);
    // And the login OTP bucket for this phone was never touched.
    expect(await app.redis.exists(`otp:${owner.phone}`, `otp_hr:${owner.phone}`, `otp_rate:${owner.phone}`)).toBe(0);
  });

  it('2+3+7. WITH a step-up the change is only STAGED: the old link stays live, the old contact point is told, the row carries the signals', async () => {
    resetDevChannelLog();
    const res = await inject('PUT', '/api/v1/vendor/profile', attacker.token, { mmgPayUrl: NEW_LINK }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mmgPayUrl).toBe(OLD_LINK);
    expect(res.json().data.mmgPayUrlPending).toBe(NEW_LINK);
    const applyAt = new Date(res.json().data.mmgPayUrlApplyAt).getTime();
    expect(Math.abs(applyAt - (Date.now() + 24 * 3_600_000))).toBeLessThan(60_000);

    // The live link — the one checkout snapshots — is unchanged.
    expect((await liveLink(vendorId)).mmgPayUrl).toBe(OLD_LINK);

    // The OLD contact point: SMS to the account phone + an inbox/push row for the owner.
    const sms = smsTo(owner.phone).at(-1)!;
    expect(sms.body).toMatch(/MMG pay link on your store account changes/);
    expect(sms.body).toMatch(/cancel it now/);
    const inbox = await app.prisma.notification.findFirst({ where: { userId: owner.userId, title: 'Your MMG pay link is changing' }, orderBy: { createdAt: 'desc' } });
    expect(inbox).not.toBeNull();
    expect((inbox!.data as Record<string, unknown>)['kind']).toBe('mmg_link_change_staged');

    // The decision row: staged, from a device and IP never seen on this account.
    const [row] = await rows(vendorId);
    expect(row?.outcome).toBe('STAGED');
    const inputs = row!.inputs as Record<string, unknown>;
    expect(inputs['signals']).toEqual(['NEW_DEVICE', 'NEW_IP']);
    expect(inputs['hadLink']).toBe(true);
    expect(inputs['newHost']).toBe('pay.example.com');
    expect(row!.sentence).toMatch(/^MMG pay link change staged from a device never seen on this account and an IP never seen on this account; the old link stays live until .+ unless the owner cancels\.$/);
  });

  it('4. the owner cancels from their own phone: the change is gone and every OTHER session — the attacker\'s — is signed out', async () => {
    const res = await inject('DELETE', '/api/v1/vendor/profile/mmg-pay-url/pending', ownerPhone.token, undefined, vendorId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ cancelled: true, revokedSessions: 1 });
    expect(await liveLink(vendorId)).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: null, mmgPayUrlApplyAt: null });

    expect((await inject('GET', '/api/v1/vendor/profile', attacker.token, undefined, vendorId)).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/vendor/profile', ownerPhone.token, undefined, vendorId)).statusCode).toBe(200);

    const all = await rows(vendorId);
    expect(all.map((r) => r.outcome)).toEqual(['STAGED', 'CANCELLED_BY_OWNER']);
    expect((all[1]!.inputs as Record<string, unknown>)['revokedSessions']).toBe(1);
    // Cancelling again is a no-op, and revokes nothing.
    expect((await inject('DELETE', '/api/v1/vendor/profile/mmg-pay-url/pending', ownerPhone.token, undefined, vendorId)).json().data).toEqual({ cancelled: false, revokedSessions: 0 });
  });

  it('5. only an unchallenged cool-off applies the change — and a session that seeded no signals reads as known', async () => {
    // The owner, from their own phone, sets a new link legitimately.
    await stepUpFor(ownerPhone.token, owner);
    const res = await inject('PUT', '/api/v1/vendor/profile', ownerPhone.token, { mmgPayUrl: NEW_LINK }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(await liveLink(vendorId)).toMatchObject({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: NEW_LINK });

    // Not due yet: the job leaves it alone.
    expect((await applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io })).applied).toBe(0);
    expect((await liveLink(vendorId)).mmgPayUrl).toBe(OLD_LINK);

    // Due: applied, told, recorded.
    resetDevChannelLog();
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrlApplyAt: new Date(Date.now() - 1000) } });
    expect((await applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io })).applied).toBe(1);
    expect(await liveLink(vendorId)).toMatchObject({ mmgPayUrl: NEW_LINK, mmgPayUrlPending: null, mmgPayUrlApplyAt: null });
    const inbox = await app.prisma.notification.findFirst({ where: { userId: owner.userId, title: 'Your new MMG pay link is live' } });
    expect((inbox?.data as Record<string, unknown> | undefined)?.['kind']).toBe('mmg_link_change_applied');
    const last = (await rows(vendorId)).at(-1)!;
    expect(last.outcome).toBe('APPLIED');
    // Running again applies nothing twice.
    expect((await applyDueMmgLinkChanges({ prisma: app.prisma, io: app.io })).applied).toBe(0);
  });

  it('clearing the link is immediate — cash-only redirects nothing', async () => {
    const res = await inject('PUT', '/api/v1/vendor/profile', ownerPhone.token, { mmgPayUrl: '' }, vendorId);
    expect(res.statusCode).toBe(200);
    expect(await liveLink(vendorId)).toMatchObject({ mmgPayUrl: null, mmgPayUrlPending: null });
    expect((await rows(vendorId)).at(-1)!.outcome).toBe('CLEARED');
  });

  it('a manager cannot touch the link at all — owner only, before the step-up is even asked', async () => {
    const manager = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const m = await makeSession(manager.userId, 'VENDOR_OWNER', { deviceId: 'manager-phone', ip: '10.0.0.8' });
    const res = await inject('PUT', '/api/v1/vendor/profile', m.token, { mmgPayUrl: NEW_LINK }, vendorId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('STAFF_FORBIDDEN');
  });

  it('staff grants are gated the same way: 403 without a step-up, 200 with', async () => {
    const hire = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const fresh = await makeSession(owner.userId, 'VENDOR_OWNER', { deviceId: 'owner-tablet', ip: '10.0.0.9' });
    const cold = await inject('POST', '/api/v1/vendor/staff', fresh.token, { phone: hire.phone, role: 'STAFF' }, vendorId);
    expect(cold.statusCode).toBe(403);
    expect(cold.json().error.code).toBe('STEP_UP_REQUIRED');
    await stepUpFor(fresh.token, owner);
    const warm = await inject('POST', '/api/v1/vendor/staff', fresh.token, { phone: hire.phone, role: 'STAFF' }, vendorId);
    expect(warm.statusCode).toBe(200);
  });

  it('6b. five wrong codes lock step-up for the account — and only step-up', async () => {
    const fresh = await makeSession(owner.userId, 'VENDOR_OWNER', { deviceId: 'owner-laptop', ip: '10.0.0.10' });
    await storeOtp(app.redis, stepUpCodeKey(owner.userId), '424242');
    for (let i = 0; i < 4; i += 1) {
      expect((await inject('POST', '/api/v1/auth/step-up/verify', fresh.token, { code: '000000' })).statusCode).toBe(400);
    }
    const fifth = await inject('POST', '/api/v1/auth/step-up/verify', fresh.token, { code: '000000' });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.code).toBe('STEP_UP_LOCKED');
    // Locked: even the right code is refused now, and so is a new send.
    expect((await inject('POST', '/api/v1/auth/step-up/verify', fresh.token, { code: '424242' })).statusCode).toBe(429);
    expect((await inject('POST', '/api/v1/auth/step-up', fresh.token)).statusCode).toBe(429);
    // The session itself still works for everything that never needed a step-up.
    expect((await inject('GET', '/api/v1/vendor/profile', fresh.token, undefined, vendorId)).statusCode).toBe(200);
    await app.redis.del(`stepup:lock:${owner.userId}`);
  });
});

describe('attack_payout_link_change — the taxi driver, same seam', () => {
  it('a driver\'s link is staged behind the same cool-off, told the same way, cancellable the same way', async () => {
    const drv = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
    const driver = await app.prisma.driver.create({
      data: {
        userId: drv.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
        licensePlate: `ATO${seq}`, driverLicenseUrl: '/uploads/x.jpg', vehicleInsuranceUrl: '/uploads/y.jpg', mmgPayUrl: OLD_LINK,
      },
    });
    const phone = await makeSession(drv.userId, 'DRIVER', { deviceId: 'driver-phone', ip: '10.0.1.1' });
    const burner = await makeSession(drv.userId, 'DRIVER', { deviceId: 'driver-burner', ip: '198.51.100.4' });

    expect((await inject('PUT', '/api/v1/driver/profile', burner.token, { mmgPayUrl: NEW_LINK })).statusCode).toBe(403);
    await stepUpFor(burner.token, drv);
    resetDevChannelLog();
    const staged = await inject('PUT', '/api/v1/driver/profile', burner.token, { mmgPayUrl: NEW_LINK });
    expect(staged.statusCode).toBe(200);
    expect(staged.json().data.mmgPayUrl).toBe(OLD_LINK);
    expect(staged.json().data.mmgPayUrlPending).toBe(NEW_LINK);
    expect(smsTo(drv.phone).at(-1)!.body).toMatch(/MMG pay link on your driver account changes/);
    const sig = await sessionSignals(app.prisma, drv.userId, burner.sessionId);
    expect(sig.signals).toEqual(['NEW_DEVICE', 'NEW_IP']);

    const cancel = await inject('DELETE', '/api/v1/driver/profile/mmg-pay-url/pending', phone.token);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data).toEqual({ cancelled: true, revokedSessions: 1 });
    expect((await inject('GET', '/api/v1/driver/profile', burner.token)).statusCode).toBe(401);
    expect(await app.prisma.driver.findUniqueOrThrow({ where: { id: driver.id }, select: { mmgPayUrl: true, mmgPayUrlPending: true } })).toEqual({ mmgPayUrl: OLD_LINK, mmgPayUrlPending: null });
    expect((await rows(driver.id)).map((r) => r.outcome)).toEqual(['STAGED', 'CANCELLED_BY_OWNER']);
  });

  it('the cool-off dial ships at 24 h', () => {
    expect(ALGO_DEFAULTS['money.linkCooloffHours']).toBe(24);
  });
});
