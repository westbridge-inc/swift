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
// Owner, 13 Oct: "the search can't find stuff when searching similar words or
// words that are part of the item".
//
// Every DATABASE search door a customer reaches — /search when the index is
// not answering (every guest, and anyone while Meilisearch is down), the
// autocomplete under the search box (always the database), and the store
// browse search (the website's search page and the app's Shops / Services
// chips) — matched ONE substring of the whole typed text. A misspelling, a
// plural, a missing letter or the words in another order found nothing.
//
// The index is provably unavailable here (dead port), so every request runs
// the database path these assertions describe. All fixtures are invented.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TENANT = `sfg-${RUN}`;
const PHONE_PREFIX = '+59200763';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const vendorIds: string[] = [];
const ids: Record<string, string> = {};

const restoreEnv = process.env['PUBLIC_TENANT_ID'];
const restoreSearchUrl = process.env['MEILISEARCH_URL'];

let seq = 0;
async function store(opts: { key: string; name: string; type?: 'RESTAURANT' | 'STORE'; status?: 'ACTIVE' | 'SUSPENDED'; items: Array<[string, string, boolean?, number?]> }) {
  seq += 1;
  const owner = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Sfg', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, tenantId: TENANT,
    },
  });
  userIds.push(owner.id);
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, tenantId: TENANT, name: opts.name, slug: `sfg-${RUN}-${seq}`,
      vendorType: opts.type ?? 'RESTAURANT', phone: `${PHONE_PREFIX}${String(500 + seq)}`,
      addressLine1: '1 Fake Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      // Georgetown: inside the launch market (#1563).
      latitude: 6.801, longitude: -58.156,
      status: opts.status ?? 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true,
    },
  });
  vendorIds.push(vendor.id);
  ids[opts.key] = vendor.id;
  const shelf = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  for (const [key, name, available, totalOrdered] of opts.items) {
    const item = await app.prisma.item.create({
      data: { vendorId: vendor.id, categoryId: shelf.id, name, basePrice: 1200, isAvailable: available ?? true, totalOrdered: totalOrdered ?? 0 },
    });
    ids[key] = item.id;
  }
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

  await app.prisma.tenant.create({ data: { id: TENANT, name: `Sfg ${RUN}`, slug: TENANT } });
  await store({
    key: 'tandooriHouse', name: 'Fakeville Tandoori House',
    items: [
      ['curry', 'Chicken Curry'], ['broccoli', 'Broccoli Stir Fry'], ['burger', 'Beef Burger'],
      ['pepperpot', 'Pepperpot'], ['patty', 'Cheese Patty'], ['tandooriChicken', 'Tandoori Chicken'],
      // never searchable: switched off by the store
      ['soup', 'Chicken Soup', false],
      // one slip from "chicken" and by far the most ordered: an exact match must still come first
      ['thicken', 'Thicken Gravy Bowl', true, 9_000_000],
    ],
  });
  // one slip from "tandoori" ("tandoor"): a correctly typed store name must not share its page with it
  await store({ key: 'tandoor', name: 'Tandoor Express', items: [['naan', 'Garlic Naan']] });
  await store({ key: 'hardware', name: 'Sunny Hardware Depot', type: 'STORE', items: [['brush', 'Paint Brush'], ['spread', 'Spread Toast']] });
  // never searchable: the whole store is suspended
  await store({ key: 'suspended', name: 'Suspended Chicken Shack', status: 'SUSPENDED', items: [['wings', 'Chicken Wings']] });

  const customer = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}999`, firstName: 'Sfg', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      tenantId: TENANT, isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  userIds.push(customer.id);
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: customer.id, token, refreshToken: nanoid(48), deviceId: 'sfg-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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
async function search(who: Who, q: string) {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=20`,
    headers: who === 'signed-in' ? { authorization: `Bearer ${token}` } : {},
  });
  expect(res.statusCode).toBe(200);
  const data = res.json().data as { vendors: Array<{ id: string }>; items: Array<{ id: string }> };
  return { vendors: data.vendors.map((v) => v.id), items: data.items.map((i) => i.id) };
}

// [query typed, the dish it must find, what kind of slip it is]
const DISHES: Array<[string, string, string]> = [
  ['chiken', 'curry', 'a missing letter'],
  ['brocoli', 'broccoli', 'a missing double letter'],
  ['broccolli', 'broccoli', 'an extra letter'],
  ['chikcen', 'curry', 'two letters swapped'],
  ['burgers', 'burger', 'a plural of a singular name'],
  ['patties', 'patty', 'an -ies plural'],
  ['curry chicken', 'curry', 'the words in another order'],
  ['pepper pot', 'pepperpot', 'one word typed as two'],
  ['tand', 'tandooriChicken', 'the start of a word'],
  ['doori', 'tandooriChicken', 'a part from inside a word'],
];

describe.each<Who>(['signed-in', 'guest'])('/search on the database path (%s)', (who) => {
  it.each(DISHES)('"%s" finds the dish (%s → %s)', async (q, key) => {
    expect((await search(who, q)).items).toContain(ids[key]);
  });

  it('a misspelt store name still finds the store', async () => {
    expect((await search(who, 'tandori')).vendors).toContain(ids['tandooriHouse']);
    expect((await search(who, 'hardwre')).vendors).toContain(ids['hardware']);
  });

  it('forgiving never widens WHO can be found: an unavailable dish and a suspended store stay out', async () => {
    const r = await search(who, 'chiken');
    expect(r.items).not.toContain(ids['soup']);
    expect(r.items).not.toContain(ids['wings']);
    expect(r.vendors).not.toContain(ids['suspended']);
  });

  it('a slip is forgiven at the start of a word only: "bread" never finds the "read" inside "Spread"', async () => {
    expect((await search(who, 'bread')).items).not.toContain(ids['spread']);
    expect((await search(who, 'spred')).items).toContain(ids['spread']);
  });

  it('an exact match ranks before a typo match, however popular the typo match', async () => {
    const r = await search(who, 'chicken');
    // both "chicken" dishes are exact; the far more ordered one-slip "Thicken" comes after them
    expect(r.items.slice(0, 2).sort()).toEqual([ids['curry'], ids['tandooriChicken']].sort());
    expect(r.items).toContain(ids['thicken']);
  });
});

describe('/search/suggestions under the search box', () => {
  it.each<Who>(['signed-in', 'guest'])('a misspelling still suggests the dish (%s)', async (who) => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/search/suggestions?q=chiken',
      headers: who === 'signed-in' ? { authorization: `Bearer ${token}` } : {},
    });
    expect(res.statusCode).toBe(200);
    const texts = (res.json().data as Array<{ text: string }>).map((s) => s.text);
    expect(texts).toContain('Chicken Curry');
    expect(texts).not.toContain('Chicken Wings');
    expect(texts).not.toContain('Chicken Soup');
  });
});

describe('/customer/vendors?search= (the website search page; the app\'s Shops and Services chips)', () => {
  async function browse(q: string) {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/customer/vendors?search=${encodeURIComponent(q)}&limit=50`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as Array<{ id: string }>).map((v) => v.id);
  }

  it('a misspelt store name still finds the store', async () => {
    expect(await browse('tandori')).toContain(ids['tandooriHouse']);
    expect(await browse('hardwre')).toContain(ids['hardware']);
  });

  it('a plural and words out of order still find the store', async () => {
    expect(await browse('houses tandoori')).toContain(ids['tandooriHouse']);
  });

  it('an exact name still finds only what it names, and a suspended store stays out', async () => {
    const exact = await browse('Sunny Hardware');
    expect(exact).toContain(ids['hardware']);
    expect(exact).not.toContain(ids['tandooriHouse']);
    // "Tandoor Express" is one slip from "tandoori": a correctly typed name never shares its page with it
    expect(await browse('tandoori house')).toEqual([ids['tandooriHouse']]);
    // ...and when nothing matches as typed, the slip match is what is found
    expect(await browse('tandor express')).toEqual([ids['tandoor']]);
    expect(await browse('chiken shack')).not.toContain(ids['suspended']);
  });
});
