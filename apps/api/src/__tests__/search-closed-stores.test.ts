import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { searchRoutes } from '../modules/search/search.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Owner ruling, 13 Oct: search SHOWS closed stores, marked closed. A customer
// who searches a store by name at night must find it (and can open it to see
// the menu and hours); ordering from it stays refused until it opens (checkout
// refuses VENDOR_CLOSED — unchanged). Before, signed-out search and the index
// path dropped every closed store, so the store "did not exist" after hours.
//
// What every search door now does with a closed store:
//   - it is returned, with `isCurrentlyOpen: false` (stores, suggestions) or
//     `vendorIsCurrentlyOpen: false` (a dish or product of that store);
//   - open matches come first, closed ones after them — a closed store never
//     pushes an open one down the page, however well it is rated.
//
// The database path is provably the one under test (dead index port). The
// index path is proved in search-engine-fill.test.ts. Fixtures are invented.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TENANT = `sfc-${RUN}`;
const PHONE_PREFIX = '+59200765';
const WORD = 'qwomble';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const vendorIds: string[] = [];
const ids: Record<string, string> = {};

const restoreEnv = process.env['PUBLIC_TENANT_ID'];
const restoreSearchUrl = process.env['MEILISEARCH_URL'];

let seq = 0;
async function store(key: string, name: string, dish: string, open: boolean, rating: number) {
  seq += 1;
  const owner = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Sfc', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, tenantId: TENANT,
    },
  });
  userIds.push(owner.id);
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, tenantId: TENANT, name, slug: `sfc-${RUN}-${seq}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}${String(500 + seq)}`, addressLine1: '1 Fake Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', isVerified: true, acceptingOrders: true,
      isCurrentlyOpen: open, averageRating: rating,
    },
  });
  vendorIds.push(vendor.id);
  const shelf = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  // the closed store's dish is the more ordered one: popularity must not lift it above an open store's
  const item = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: shelf.id, name: dish, basePrice: 1200, isAvailable: true, totalOrdered: open ? 1 : 9_000_000 },
  });
  ids[key] = vendor.id;
  ids[`${key}Dish`] = item.id;
}

beforeAll(async () => {
  process.env['MEILISEARCH_URL'] = 'http://127.0.0.1:9';
  process.env['PUBLIC_TENANT_ID'] = TENANT;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  await app.prisma.tenant.create({ data: { id: TENANT, name: `Sfc ${RUN}`, slug: TENANT } });
  // The CLOSED store is the better rated one: an honest order still lists the open store first.
  await store('night', `${WORD} Night Grill`, `${WORD} Night Pepperpot`, false, 4.9);
  await store('day', `${WORD} Day Grill`, `${WORD} Day Pepperpot`, true, 3.0);

  const customer = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}999`, firstName: 'Sfc', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      tenantId: TENANT, isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  userIds.push(customer.id);
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: customer.id, token, refreshToken: nanoid(48), deviceId: 'sfc-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: TENANT } });
  await app.close();
  if (restoreEnv === undefined) delete process.env['PUBLIC_TENANT_ID'];
  else process.env['PUBLIC_TENANT_ID'] = restoreEnv;
  if (restoreSearchUrl === undefined) delete process.env['MEILISEARCH_URL'];
  else process.env['MEILISEARCH_URL'] = restoreSearchUrl;
});

type Who = 'signed-in' | 'guest';
const headers = (who: Who) => (who === 'signed-in' ? { authorization: `Bearer ${token}` } : {});

describe.each<Who>(['signed-in', 'guest'])('closed stores in search (%s)', (who) => {
  it('/search returns the closed store, marked closed, after the open one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/search?q=${WORD}&limit=20`, headers: headers(who) });
    expect(res.statusCode).toBe(200);
    const vendors = res.json().data.vendors as Array<{ id: string; isCurrentlyOpen: boolean }>;
    expect(vendors.map((v) => v.id)).toEqual([ids['day'], ids['night']]);
    expect(vendors.map((v) => v.isCurrentlyOpen)).toEqual([true, false]);
  });

  it('/search returns a closed store\'s dish, marked by its store\'s closed state, after the open store\'s', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/search?q=${WORD}%20pepperpot&limit=20`, headers: headers(who) });
    const items = res.json().data.items as Array<{ id: string; vendorIsCurrentlyOpen: boolean }>;
    expect(items.map((i) => i.id)).toEqual([ids['dayDish'], ids['nightDish']]);
    expect(items.map((i) => i.vendorIsCurrentlyOpen)).toEqual([true, false]);
  });

  it('/search/suggestions offers the closed store and its dish, marked closed, after the open ones', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/search/suggestions?q=${WORD}`, headers: headers(who) });
    const data = res.json().data as Array<{ text: string; type: string; isCurrentlyOpen: boolean }>;
    expect(data.filter((s) => s.type === 'vendor')).toEqual([
      { text: `${WORD} Day Grill`, type: 'vendor', isCurrentlyOpen: true },
      { text: `${WORD} Night Grill`, type: 'vendor', isCurrentlyOpen: false },
    ]);
    expect(data.filter((s) => s.type === 'item')).toEqual([
      { text: `${WORD} Day Pepperpot`, type: 'item', isCurrentlyOpen: true },
      { text: `${WORD} Night Pepperpot`, type: 'item', isCurrentlyOpen: false },
    ]);
  });

  it('/customer/vendors?search= lists the closed store, marked closed, after the open one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors?search=${WORD}&limit=50`, headers: headers(who) });
    expect(res.statusCode).toBe(200);
    const mine = (res.json().data as Array<{ id: string; isCurrentlyOpen: boolean }>).filter((v) => vendorIds.includes(v.id));
    expect(mine.map((v) => v.id)).toEqual([ids['day'], ids['night']]);
    expect(mine.map((v) => v.isCurrentlyOpen)).toEqual([true, false]);
  });
});
