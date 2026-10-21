import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { wordFreeTag } from './helpers/fixture-ids';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';

// ---------------------------------------------------------------------------
// [owner 21 Oct · COORD 03:15Z] A store switch ends in the state the client
// asked for. The switches used to FLIP whatever the server held and ignore
// the body: with the phone and the website open at once, an owner closed the
// store on the phone, a manager's stale "Close" on the website then OPENED it,
// and it took orders. Now a desired state is honoured (asking for the state it
// is already in changes nothing); an older app that sends no body (store builds
// 9 and 11) still flips.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const run = nanoid(7);
let app: FastifyInstance;
let token: string;
let userId: string;
let vendorId: string;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-vendor-switch-desired-state');

const put = (path: 'toggle-open' | 'toggle-orders', body?: unknown) => app.inject({
  method: 'PUT', url: `/api/v1/vendor/vendor/${path}`,
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
});
const flags = () => sys(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { isCurrentlyOpen: true, acceptingOrders: true } }));
const setFlags = (data: { isCurrentlyOpen?: boolean; acceptingOrders?: boolean }) => sys(() => app.prisma.vendor.update({ where: { id: vendorId }, data }));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `+59200562${Date.now()}`, firstName: 'Switch', lastName: 'Owner', tenantId: 'swift-default', countryCode: 'GY',
      roles: ['VENDOR_OWNER', 'CUSTOMER'] as never[], activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true,
    } });
    userId = user.id;
    token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `switch-${run}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: `Switch Store ${wordFreeTag(8)}`, slug: `switch-${run.toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5920000562',
      addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
      isCurrentlyOpen: false, acceptingOrders: true,
    } });
    vendorId = vendor.id;
  });
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId } });
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  });
  await app.close();
});

describe('Store open: the state the client asked for', () => {
  it('a stale "Close" on a screen that still shows the store open never OPENS it', async () => {
    await setFlags({ isCurrentlyOpen: false }); // the owner already closed it on the phone
    const res = await put('toggle-open', { isCurrentlyOpen: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.isCurrentlyOpen).toBe(false);
    expect((await flags()).isCurrentlyOpen).toBe(false);
  });

  it('"Open" opens a closed store, and a second "Open" keeps it open', async () => {
    await setFlags({ isCurrentlyOpen: false });
    expect((await put('toggle-open', { isCurrentlyOpen: true })).json().data.isCurrentlyOpen).toBe(true);
    expect((await put('toggle-open', { isCurrentlyOpen: true })).json().data.isCurrentlyOpen).toBe(true);
    expect((await flags()).isCurrentlyOpen).toBe(true);
  });

  it('"Close" closes an open store', async () => {
    await setFlags({ isCurrentlyOpen: true });
    expect((await put('toggle-open', { isCurrentlyOpen: false })).json().data.isCurrentlyOpen).toBe(false);
    expect((await flags()).isCurrentlyOpen).toBe(false);
  });

  it('an older app that sends no body (builds 9 and 11) still flips, both ways', async () => {
    await setFlags({ isCurrentlyOpen: false });
    expect((await put('toggle-open')).json().data.isCurrentlyOpen).toBe(true);
    expect((await put('toggle-open')).json().data.isCurrentlyOpen).toBe(false);
    expect((await put('toggle-open', {})).json().data.isCurrentlyOpen).toBe(true); // an empty body is an old app too
  });

  it('a desired state that is not true/false is refused and changes nothing', async () => {
    await setFlags({ isCurrentlyOpen: true });
    const res = await put('toggle-open', { isCurrentlyOpen: 'no' });
    expect(res.statusCode).toBe(400);
    expect((await flags()).isCurrentlyOpen).toBe(true);
  });
});

describe('Accepting orders: the state the client asked for', () => {
  it('a stale "Pause" on a screen behind never turns orders back ON', async () => {
    await setFlags({ acceptingOrders: false }); // already paused on the other screen
    const res = await put('toggle-orders', { acceptingOrders: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acceptingOrders).toBe(false);
    expect((await flags()).acceptingOrders).toBe(false);
  });

  it('a stale "Resume" on a screen behind never PAUSES orders', async () => {
    await setFlags({ acceptingOrders: true });
    const res = await put('toggle-orders', { acceptingOrders: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acceptingOrders).toBe(true);
    expect((await flags()).acceptingOrders).toBe(true);
  });

  it('"Pause" pauses, and an older app with no body still flips it off', async () => {
    await setFlags({ acceptingOrders: true });
    expect((await put('toggle-orders', { acceptingOrders: false })).json().data.acceptingOrders).toBe(false);
    await setFlags({ acceptingOrders: true });
    expect((await put('toggle-orders')).json().data.acceptingOrders).toBe(false);
    expect((await flags()).acceptingOrders).toBe(false);
  });

  it('a desired state that is not true/false is refused and changes nothing', async () => {
    await setFlags({ acceptingOrders: true });
    expect((await put('toggle-orders', { acceptingOrders: 1 })).statusCode).toBe(400);
    expect((await flags()).acceptingOrders).toBe(true);
  });
});
