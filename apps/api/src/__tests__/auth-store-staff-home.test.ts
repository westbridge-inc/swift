import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { buildApp } from '../app';
import { runWithoutTenant } from '../plugins/prisma';
import { devChannelLog } from '../providers/notifications/channels';
import { guyanaDayKey } from '../utils/guyana-day';
import { fixtureTag, testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BUG-HUNT F03] Branch staff hold no partner role (roles ['CUSTOMER'], no vendorOwner): the website read them as a
// customer and refused sign-in with "No business or earner profile on this account yet". The server now says so on
// the signed-in user: `storeStaff` is true exactly when this account has a seat at a store, the same row
// GET /vendor/stores opens for them, on both answers a browser reads (POST /auth/verify-otp and GET /auth/me).
// Synthetic data only.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-auth-store-staff-home');
const userIds: string[] = [];
const ownerIds: string[] = [];
const vendorIds: string[] = [];
const DAY = 86_400_000;

type Actor = { userId: string; token: string; phone: string };

async function makeUser(): Promise<Actor> {
  return sys(async () => {
    const phone = testPhone();
    const user = await app.prisma.user.create({
      data: { phone, firstName: 'Staff', lastName: `Home${fixtureTag(4)}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, status: 'ACTIVE', customer: { create: {} } },
      select: { id: true },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(64), deviceId: `staff-${fixtureTag(6)}`, deviceType: 'web', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token, phone };
  });
}

async function makeStore(ownerUserId: string): Promise<string> {
  return sys(async () => {
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
    ownerIds.push(owner.id);
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: `Staff Home ${fixtureTag(6)}`, slug: `staff-home-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
        phone: testPhone(), addressLine1: '1 Test Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
      },
      select: { id: true },
    });
    vendorIds.push(vendor.id);
    return vendor.id;
  });
}

const me = async (token: string) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res.json().data as { user: Record<string, unknown> };
};
const stores = (token: string) => app.inject({ method: 'GET', url: '/api/v1/vendor/stores', headers: { authorization: `Bearer ${token}` } });

/** The real sign-in a browser does: the code the server texted, on the browser client. */
async function signInWithCode(phone: string) {
  const day = guyanaDayKey(new Date());
  await app.redis.del(`otp_rate:${phone}`, `otp_hr:${phone}`, `otp_attempt:${phone}`, `otp_phone_day:${day}:${phone}`, `sms_global_day:${day}`, `sms_known_day:${day}`, `otp_ip_day:${day}:127.0.0.1`);
  const before = devChannelLog.length;
  const sent = await app.inject({ method: 'POST', url: '/api/v1/auth/send-otp', headers: { 'x-swift-client': 'web' }, payload: { phone } });
  expect(sent.statusCode, sent.body).toBe(200);
  const sms = devChannelLog.slice(before).filter((entry) => entry.channel === 'sms' && entry.to === phone).at(-1);
  const code = sms?.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code was texted to the test number');
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: { 'x-swift-client': 'web' }, payload: { phone, code } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { isNewUser: boolean; user: Record<string, unknown> };
}

let customer: Actor;
let owner: Actor;
let staff: Actor;
let manager: Actor;
let removed: Actor;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  customer = await makeUser();
  owner = await makeUser();
  staff = await makeUser();
  manager = await makeUser();
  removed = await makeUser();
  const vendorId = await makeStore(owner.userId);
  await sys(async () => {
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: removed.userId, role: 'STAFF', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.deleteMany({ where: { userId: removed.userId } });
  });
}, 60_000);

afterAll(async () => {
  await sys(async () => {
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app?.close();
});

describe('[F03] the signed-in user says whether this account has a seat at a store', () => {
  it('GET /auth/me: staff and a manager yes; a customer, an owner (they hold a role) and someone removed no', async () => {
    expect((await me(staff.token)).user['storeStaff']).toBe(true);
    expect((await me(manager.token)).user['storeStaff']).toBe(true);
    expect((await me(customer.token)).user['storeStaff']).toBe(false);
    expect((await me(owner.token)).user['storeStaff']).toBe(false);
    expect((await me(removed.token)).user['storeStaff']).toBe(false);
  });

  it('POST /auth/verify-otp says the same, and the membership rows never ride along', async () => {
    const signedIn = await signInWithCode(staff.phone);
    expect(signedIn.isNewUser).toBe(false);
    expect(signedIn.user['storeStaff']).toBe(true);
    expect(signedIn.user).not.toHaveProperty('vendorStaffMemberships');
    expect((await signInWithCode(customer.phone)).user['storeStaff']).toBe(false);
    expect((await me(staff.token)).user).not.toHaveProperty('vendorStaffMemberships');
  });

  it('the flag is the same fact as the store door: yes exactly when GET /vendor/stores opens for them', async () => {
    for (const actor of [staff, manager, customer, removed]) {
      const held = (await me(actor.token)).user['storeStaff'] === true;
      expect((await stores(actor.token)).statusCode, actor.userId).toBe(held ? 200 : 403);
    }
  });
});
