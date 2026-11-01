import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS API · COORD 31 Oct 2026] PUT /vendor/profile and the store's own words.
//
// (1) The store's name, description and address are the OWNER's to change (as the phone offers nobody and the website
//     offers the owner only): a manager is refused with the store-role code before anything is read or written.
// (2) A store a person at Swift has checked keeps the name it was checked under: a rename is refused (support changes
//     it), keyed on a durable signal (the store was ever live, vendors.firstLiveAt, or is verified now), never on today's
//     isVerified alone. A store nobody has checked yet may still rename, and its new words are judged at once.
// (3) The minimums are sign-up's (partner/business-input.ts): a name of 2+, a street address of 3+, a city of 2+.
// No shipped app sends any of these fields (build 12 / vc8 send only money, number, rule and capacity settings).
// Synthetic stores only.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920358';
const FIXTURE = 'web-settings-profile-words-fixture';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string };
let owner: Actor;
let manager: Actor;
let staff: Actor;
let checkedId: string;
let pendingId: string;
let lapsedId: string;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Words${seq}`, roles, activeRole, isPhoneVerified: true },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `wsp-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

function getProfile(who: Actor, vendorId: string) {
  return app.inject({ method: 'GET', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${who.token}`, 'x-vendor-id': vendorId } } as InjectOptions);
}
function put(who: Actor, vendorId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT', url: '/api/v1/vendor/profile',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}`, 'x-vendor-id': vendorId },
    payload,
  } as InjectOptions);
}
const row = (id: string) => sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id } }));

async function purgeFixtures() {
  await sys(async () => {
    const ids = (await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } })).map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: vendorIds } }, { userId: { in: ids } }] }, 'WEB-SETTINGS profile-words fixture cleanup');
    await app.prisma.vendorStaff.deleteMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { userId: { in: ids } }] } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await purgeFixtures();

  owner = await makeUser('Dev', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  manager = await makeUser('Mia', ['CUSTOMER'], 'CUSTOMER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const base = (name: string) => ({
    ownerId: ownerRow.id, name, slug: `wsp-${nanoid(8).toLowerCase()}`, vendorType: 'STORE' as const, phone: `${PHONE_PREFIX}9${seq++}`,
    addressLine1: '1 Words Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, description: 'Synthetic shop',
  });
  checkedId = (await sys(() => app.prisma.vendor.create({ data: { ...base('Checked Shop'), status: 'ACTIVE', isVerified: true, firstLiveAt: new Date(Date.now() - 30 * DAY),
    mmgNumber: '+5926001234', mmgNumberPending: '+5926005678', mmgNumberApplyAt: new Date(Date.now() + DAY) } }))).id;
  pendingId = (await sys(() => app.prisma.vendor.create({ data: { ...base('Waiting Shop'), status: 'PENDING_APPROVAL', isVerified: false, firstLiveAt: null } }))).id;
  // Checked once, then its documents lapsed: today's isVerified is false, the durable mark stays.
  lapsedId = (await sys(() => app.prisma.vendor.create({ data: { ...base('Lapsed Shop'), status: 'SUSPENDED', isVerified: false, firstLiveAt: new Date(Date.now() - 60 * DAY) } }))).id;
  for (const vendorId of [checkedId, pendingId, lapsedId]) {
    await sys(() => app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } }));
  }
  staff = await makeUser('Sam', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.vendorStaff.create({ data: { vendorId: checkedId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } }));
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('[WEB-SETTINGS API] (1) the store\'s name, description and address are the owner\'s', () => {
  it.each([
    ['name', { name: 'Manager Shop' }],
    ['description', { description: 'Changed by a manager' }],
    ['addressLine1', { addressLine1: '9 Other Street' }],
    ['addressLine2', { addressLine2: 'Upstairs' }],
    ['city', { city: 'Linden' }],
    ['region', { region: 'Upper Demerara' }],
  ])('a manager changing %s is refused with STAFF_FORBIDDEN, and nothing changes', async (_field, payload) => {
    const before = await row(pendingId);
    const res = await put(manager, pendingId, payload);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_FORBIDDEN');
    const after = await row(pendingId);
    expect([after.name, after.description, after.addressLine1, after.addressLine2, after.city, after.region])
      .toEqual([before.name, before.description, before.addressLine1, before.addressLine2, before.city, before.region]);
  });

  it('a manager is refused even with an invalid value (the role is judged first), and keeps the settings managers have', async () => {
    expect((await put(manager, pendingId, { name: '' })).json().error.code).toBe('STAFF_FORBIDDEN');
    const ok = await put(manager, pendingId, { requirePickupCode: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await row(pendingId)).requirePickupCode).toBe(true);
  });

  it('the owner changes the description and address of a checked store', async () => {
    const res = await put(owner, checkedId, { description: 'Rice, flour and soap', addressLine1: '  2 Words Street  ', city: 'Georgetown' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(checkedId);
    expect([after.description, after.addressLine1]).toEqual(['Rice, flour and soap', '2 Words Street']);
  });
});

describe('[WEB-SETTINGS API] (2) a store a person checked keeps the name it was checked under', () => {
  it('a rename of a checked store is refused with CHECKED_NAME_RENAME and the name stays', async () => {
    const res = await put(owner, checkedId, { name: 'Brand New Name' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKED_NAME_RENAME');
    expect(res.json().error.message).toMatch(/support/i);
    expect((await row(checkedId)).name).toBe('Checked Shop');
  });

  it('the durable mark counts: a store live once whose documents lapsed (isVerified false) is refused too', async () => {
    const res = await put(owner, lapsedId, { name: 'Lapsed Renamed' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('CHECKED_NAME_RENAME');
    expect((await row(lapsedId)).name).toBe('Lapsed Shop');
  });

  it('the same name sent again (with another field) is not a rename', async () => {
    const res = await put(owner, checkedId, { name: 'Checked Shop', description: 'Still the same shop' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a store nobody has checked yet may rename, and its new words are judged at once', async () => {
    const ok = await put(owner, pendingId, { name: 'Waiting Grocery' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.storeCheck).toBeNull();
    const held = await put(owner, pendingId, { name: 'Waiting Rum Shop' });
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().data.storeCheck).toMatchObject({ status: 'WAITING_FOR_CHECK', term: 'rum' });
    expect((await put(owner, pendingId, { name: 'Waiting Grocery' })).json().data.storeCheck).toBeNull();
  });
});

describe('[WEB-SETTINGS API] (3) the minimums are sign-up\'s', () => {
  it.each([
    ['a one-letter name', { name: 'A' }],
    ['a name of spaces', { name: '   ' }],
    ['a two-letter street address', { addressLine1: '1 ' }],
    ['an empty street address', { addressLine1: '' }],
    ['a one-letter city', { city: ' X ' }],
  ])('%s is refused (400) and nothing changes', async (_what, payload) => {
    const before = await row(pendingId);
    const res = await put(owner, pendingId, payload);
    expect(res.statusCode, res.body).toBe(400);
    const after = await row(pendingId);
    expect([after.name, after.addressLine1, after.city]).toEqual([before.name, before.addressLine1, before.city]);
  });

  it('the shortest allowed values pass', async () => {
    const res = await put(owner, pendingId, { name: 'Wa', addressLine1: '1 A', city: 'Ab' });
    expect(res.statusCode, res.body).toBe(200);
    const after = await row(pendingId);
    expect([after.name, after.addressLine1, after.city]).toEqual(['Wa', '1 A', 'Ab']);
  });
});

describe('[WEB-SETTINGS API · REVIEW-G #2277 S4-2] a manager or staff member reads the store\'s MMG number masked', () => {
  const storeOf = async (who: Actor) => {
    const res = await getProfile(who, checkedId);
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.body, store: (res.json().data.vendors as Array<Record<string, unknown>>).find((v) => v['id'] === checkedId)! };
  };

  it('the owner reads the whole number (live and staged)', async () => {
    const { store } = await storeOf(owner);
    expect([store['mmgNumber'], store['mmgNumberPending']]).toEqual(['+5926001234', '+5926005678']);
  });

  it.each([['manager', () => manager], ['staff', () => staff]])('a %s reads "+592 ••• •NNN" only, never the whole number', async (_who, who) => {
    const { body, store } = await storeOf(who());
    expect([store['mmgNumber'], store['mmgNumberPending']]).toEqual(['+592 ••• •234', '+592 ••• •678']);
    expect(body).not.toMatch(/6001234|6005678/);
  });

  it('a manager\'s profile save answers with the number masked too', async () => {
    const res = await put(manager, checkedId, { requirePickupCode: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toMatch(/6001234|6005678/);
    expect([res.json().data.mmgNumber, res.json().data.mmgNumberPending]).toEqual(['+592 ••• •234', '+592 ••• •678']);
  });
});
