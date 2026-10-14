import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext } from '../plugins/prisma';
import { tenantContext } from '../plugins/tenant-context';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { searchRoutes } from '../modules/search/search.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Owner, 13 Oct: search "can't find stuff". The signed-in phone app's search
// asks the index (Meilisearch) first. Four ways that path answered short or
// empty while the store and the dish were live in the database:
//
//   1. UNDER-FILL — the index was asked for exactly `limit` hits, and the live
//      gates (open now, still visible, inside the launch market) ran AFTER it.
//      Ten out-of-market or since-closed hits filled the window and the live
//      match at rank eleven was never fetched: an empty answer.
//   2. A STALE OPEN FLAG — the index filtered `isCurrentlyOpen = true` on the
//      copy it took at its last sync. A store that opened since was invisible
//      to signed-in search although the live gate (the database) says open.
//   3. A WORD INSIDE A WORD — the index matches whole words and word starts;
//      "doori" never finds "Tandoori". The database does, and was never asked.
//   4. NO SECOND CHANCE — if the index was not reachable at the moment the API
//      started, search ran on the plain database path until the next restart.
//
// Only the external index client is replaced, by a double that honours the
// `limit`, `offset` and `filter` the route actually sends. The routes, auth,
// the live visibility gates and the database are real. Fixtures are invented.
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;
const engine = vi.hoisted(() => ({
  ready: true,
  initCalls: 0,
  vendorDocs: [] as Doc[],
  itemDocs: [] as Doc[],
  vendorCalls: [] as Array<{ q: string; opts: Record<string, unknown> }>,
  itemCalls: [] as Array<{ q: string; opts: Record<string, unknown> }>,
  warmed: 0,
  warmContexts: [] as Array<{ tenantId: string | null; mode: string; capability: string | null }>,
}));

function page(docs: Doc[], opts: { filter?: string[]; limit?: number; offset?: number } = {}) {
  // The two filter clauses the route can send that the double must honour.
  const filter = opts.filter ?? [];
  const openOnly = filter.includes('isCurrentlyOpen = true');
  const hits = docs.filter((d) => !openOnly || d['isCurrentlyOpen'] === true);
  const offset = opts.offset ?? 0;
  return { hits: hits.slice(offset, offset + (opts.limit ?? 20)), estimatedTotalHits: hits.length, processingTimeMs: 1 };
}

vi.mock('../modules/search/search.service', async () => {
  const { getTenantContext } = await import('../plugins/tenant-context');
  return {
    SearchService: class {
      constructor(private prisma: { vendor: { count: (a: unknown) => Promise<number> } }) {}
      async initialize() {
        engine.initCalls += 1;
        if (!engine.ready) throw new Error('index unreachable (test)');
      }
      // The real syncs read every operator's catalogue: one real read here,
      // under whatever context the route runs the warm-up in.
      async syncAllVendors() {
        engine.warmContexts.push(getTenantContext());
        await this.prisma.vendor.count({ where: { id: 'no-such-vendor' } });
        return 0;
      }
      async syncAllItems() { engine.warmed += 1; return 0; }
      async searchVendors(_tenant: string, q: string, opts: Record<string, unknown> = {}) {
        engine.vendorCalls.push({ q, opts });
        const filter = opts['openOnly'] ? ['isCurrentlyOpen = true'] : [];
        return page(engine.vendorDocs, { filter, limit: opts['limit'] as number, offset: opts['offset'] as number });
      }
      async searchItems(_tenant: string, q: string, opts: Record<string, unknown> = {}) {
        engine.itemCalls.push({ q, opts });
        return page(engine.itemDocs, { limit: opts['limit'] as number, offset: opts['offset'] as number });
      }
    },
  };
});

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TENANT = `sfe-${RUN}`;
const PHONE_PREFIX = '+59200764';
const DAY = 24 * 60 * 60 * 1000;
const GEORGETOWN = { latitude: 6.801, longitude: -58.156 };
const ABROAD = { latitude: 25.76, longitude: -80.19 };

let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const vendorIds: string[] = [];
const ids: Record<string, string> = {};
const docs: Record<string, { vendor: Doc; item: Doc }> = {};

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  // As the real app does (app.ts): every request opens its own tenant context,
  // which authentication then binds — so deny mode sees a bound request.
  a.addHook('onRequest', (_request, _reply, done) => { beginRequestTenantContext(); done(); });
  registerErrorHandler(a);
  await a.register(prismaPlugin);
  await a.register(redisPlugin);
  await a.register(authPlugin);
  await a.register(socketPlugin);
  await a.register(searchRoutes, { prefix: '/api/v1' });
  await a.ready();
  return a;
}

let seq = 0;
async function store(key: string, name: string, dish: string, opts: { at?: { latitude: number; longitude: number }; open?: boolean; indexedOpen?: boolean } = {}) {
  seq += 1;
  const owner = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Sfe', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, tenantId: TENANT,
    },
  });
  userIds.push(owner.id);
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const at = opts.at ?? GEORGETOWN;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, tenantId: TENANT, name, slug: `sfe-${RUN}-${seq}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}${String(500 + seq)}`, addressLine1: '1 Fake Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      ...at, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: opts.open ?? true, acceptingOrders: true,
    },
  });
  vendorIds.push(vendor.id);
  const shelf = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: shelf.id, name: dish, basePrice: 1500, isAvailable: true } });
  ids[key] = vendor.id;
  ids[`${key}Dish`] = item.id;
  // What the index holds — its own copy, taken at its last sync.
  docs[key] = {
    vendor: { id: `${TENANT}__${vendor.id}`, entityId: vendor.id, tenantId: TENANT, name, vendorType: 'RESTAURANT', ...at, isCurrentlyOpen: opts.indexedOpen ?? opts.open ?? true },
    item: { id: `${TENANT}__${item.id}`, entityId: item.id, tenantId: TENANT, name: dish, vendorId: vendor.id, vendorName: name, basePrice: 1500, createdAt: Date.now(), vendorIsCurrentlyOpen: opts.indexedOpen ?? opts.open ?? true },
  };
}

function signedIn(q: string, limit = 10) {
  return app.inject({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`, headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.prisma.tenant.create({ data: { id: TENANT, name: `Sfe ${RUN}`, slug: TENANT } });
  for (let n = 1; n <= 10; n += 1) await store(`abroad${n}`, `Faraway Grill ${n}`, `Faraway Wrap ${n}`, { at: ABROAD });
  for (let n = 1; n <= 10; n += 1) await store(`closed${n}`, `Shut Grill ${n}`, `Shut Wrap ${n}`, { open: false, indexedOpen: true });
  await store('near', 'Nearby Grill', 'Nearby Wrap');
  await store('bakery', 'Morning Bakery', 'Butter Bun', { open: true, indexedOpen: false });
  await store('tandoori', 'Fakeville Tandoori House', 'Tandoori Chicken');

  const customer = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}999`, firstName: 'Sfe', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      tenantId: TENANT, isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  userIds.push(customer.id);
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: customer.id, token, refreshToken: nanoid(48), deviceId: 'sfe-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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
});

describe('the index path fills the page from live matches', () => {
  it('ten out-of-market hits ahead of a live one do not leave the page empty', async () => {
    engine.vendorDocs = [...Array.from({ length: 10 }, (_, i) => docs[`abroad${i + 1}`]!.vendor), docs['near']!.vendor];
    engine.itemDocs = [...Array.from({ length: 10 }, (_, i) => docs[`abroad${i + 1}`]!.item), docs['near']!.item];
    // A query the database cannot match on its own: only the index's hits can fill this page.
    const res = await signedIn('qzxv', 10);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.vendors.map((v: { id: string }) => v.id)).toEqual([ids['near']]);
    expect(data.items.map((i: { id: string }) => i.id)).toEqual([ids['nearDish']]);
  });

  it('[owner 13 Oct] since-closed hits stay in the answer, marked closed, after the open one', async () => {
    engine.vendorDocs = [...Array.from({ length: 10 }, (_, i) => docs[`closed${i + 1}`]!.vendor), docs['near']!.vendor];
    engine.itemDocs = [];
    const res = await signedIn('qzxv', 10);
    const vendors = res.json().data.vendors as Array<{ id: string; isCurrentlyOpen: boolean }>;
    expect(vendors).toHaveLength(10);
    expect(vendors[0]).toMatchObject({ id: ids['near'], isCurrentlyOpen: true });
    const closedIds = new Set(Array.from({ length: 10 }, (_, i) => ids[`closed${i + 1}`]));
    for (const v of vendors.slice(1)) {
      expect(closedIds.has(v.id)).toBe(true);
      expect(v.isCurrentlyOpen).toBe(false); // the live state, not the index copy (which says open)
    }
  });

  it('a store that opened after its last index sync is found and shown open (the live gate decides open, not the stale copy)', async () => {
    engine.vendorDocs = [docs['bakery']!.vendor];
    engine.itemDocs = [];
    const res = await signedIn('qzxv', 10);
    const vendors = res.json().data.vendors as Array<{ id: string; isCurrentlyOpen: boolean }>;
    expect(vendors.map((v) => v.id)).toEqual([ids['bakery']]);
    expect(vendors[0]!.isCurrentlyOpen).toBe(true);
  });

  it('[owner 13 Oct] a dish is marked by its store\'s LIVE open state, open stores\' dishes first', async () => {
    engine.vendorDocs = [];
    // the index copies are stale both ways: closed1 indexed open, the bakery indexed closed
    engine.itemDocs = [docs['closed1']!.item, docs['bakery']!.item];
    const items = (await signedIn('qzxv', 10)).json().data.items as Array<{ id: string; vendorIsCurrentlyOpen: boolean }>;
    expect(items.map((i) => [i.id, i.vendorIsCurrentlyOpen])).toEqual([[ids['bakeryDish'], true], [ids['closed1Dish'], false]]);
  });

  it('never more than the page asked for', async () => {
    engine.vendorDocs = [docs['near']!.vendor, docs['bakery']!.vendor, docs['tandoori']!.vendor];
    engine.itemDocs = [docs['near']!.item, docs['bakery']!.item, docs['tandoori']!.item];
    const data = (await signedIn('qzxv', 2)).json().data;
    expect(data.vendors).toHaveLength(2);
    expect(data.items).toHaveLength(2);
    // index order is kept
    expect(data.vendors.map((v: { id: string }) => v.id)).toEqual([ids['near'], ids['bakery']]);
  });
});

describe('a short index answer is topped up from the database', () => {
  it('"doori" — a part from inside a word — finds the dish and its store', async () => {
    engine.vendorDocs = [];
    engine.itemDocs = [];
    const data = (await signedIn('doori', 10)).json().data;
    expect(data.items.map((i: { id: string }) => i.id)).toContain(ids['tandooriDish']);
    expect(data.vendors.map((v: { id: string }) => v.id)).toContain(ids['tandoori']);
  });

  it('[review Md] a dish the index returned is never repeated by the database top-up, even when the database also matches it', async () => {
    engine.vendorDocs = [];
    engine.itemDocs = [docs['tandoori']!.item];
    const items = (await signedIn('tandoori', 10)).json().data.items as Array<{ id: string }>;
    expect(items.filter((i) => i.id === ids['tandooriDish'])).toHaveLength(1);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('[review S2-1] the top-up asks the database for exact spellings only — slips are the index\'s job', async () => {
    engine.vendorDocs = [];
    engine.itemDocs = [];
    // "tandori" is one slip from "Tandoori": the database slip tiers would find it; the top-up must not run them
    const data = (await signedIn('tandori', 10)).json().data;
    expect(data.items.map((i: { id: string }) => i.id)).not.toContain(ids['tandooriDish']);
    expect(data.vendors.map((v: { id: string }) => v.id)).not.toContain(ids['tandoori']);
    // ...while an exact piece inside a word still tops up
    expect((await signedIn('doori', 10)).json().data.items.map((i: { id: string }) => i.id)).toContain(ids['tandooriDish']);
  });

  it('a top-up never repeats what the index already returned, never adds an out-of-market store, and lists closed stores after open ones, marked closed', async () => {
    engine.vendorDocs = [docs['tandoori']!.vendor];
    engine.itemDocs = [docs['tandoori']!.item];
    const data = (await signedIn('grill', 50)).json().data;
    const vendors = data.vendors as Array<{ id: string; isCurrentlyOpen: boolean }>;
    const vendorIdsOut = vendors.map((v) => v.id);
    expect(vendorIdsOut[0]).toBe(ids['tandoori']);
    expect(new Set(vendorIdsOut).size).toBe(vendorIdsOut.length);
    expect(vendorIdsOut).toContain(ids['near']);
    for (let n = 1; n <= 10; n += 1) {
      expect(vendorIdsOut).not.toContain(ids[`abroad${n}`]);
      // [owner 13 Oct] closed stores are found too, marked closed
      expect(vendors.find((v) => v.id === ids[`closed${n}`])?.isCurrentlyOpen).toBe(false);
    }
    const lastOpen = vendors.map((v) => v.isCurrentlyOpen).lastIndexOf(true);
    const firstClosed = vendors.map((v) => v.isCurrentlyOpen).indexOf(false);
    expect(lastOpen).toBeLessThan(firstClosed);
  });
});

describe('an index that was down when the API started is tried again', () => {
  it('search moves to the index once it answers, without a restart', async () => {
    engine.ready = false;
    const before = engine.initCalls;
    const late = await buildApp();
    try {
      await vi.waitFor(() => expect(engine.initCalls).toBe(before + 1));
      engine.ready = true;
      engine.vendorDocs = [docs['near']!.vendor];
      engine.itemDocs = [];
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const ask = () => late.inject({ method: 'GET', url: '/api/v1/search?q=qzxv&limit=5', headers: { authorization: `Bearer ${token}` } });
      // The first ask runs on the database and starts the retry in the background.
      expect((await ask()).statusCode).toBe(200);
      await vi.waitFor(() => expect(engine.initCalls).toBeGreaterThan(before + 1));
      const calls = engine.vendorCalls.length;
      await vi.waitFor(async () => {
        await ask();
        expect(engine.vendorCalls.length).toBeGreaterThan(calls);
      });
      // ...and that retry, though a signed-in request started it, ran as the
      // named platform-wide work — never as the caller's tenant.
      expect(engine.warmContexts.length).toBeGreaterThan(0);
      for (const ctx of engine.warmContexts) expect(ctx).toEqual({ tenantId: null, mode: 'system', capability: 'search-index-warm' });
    } finally {
      vi.useRealTimers();
      engine.ready = true;
      await late.close();
    }
  });

  it('under TENANT_UNSCOPED_ACCESS=deny the warm-up still fills the index (it is named system work, not an unbound read)', async () => {
    const warmedBefore = engine.warmed;
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', 'deny');
    // Booted the way the server boots: a composition root with NO tenant
    // context (earlier injects can leave one on this test's async flow).
    const late = await tenantContext.exit(() => buildApp());
    try {
      await vi.waitFor(() => expect(engine.warmed).toBe(warmedBefore + 1));
      engine.vendorDocs = [docs['near']!.vendor];
      engine.itemDocs = [];
      const calls = engine.vendorCalls.length;
      const res = await late.inject({ method: 'GET', url: '/api/v1/search?q=qzxv&limit=5', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode, res.body).toBe(200);
      expect(engine.vendorCalls.length).toBe(calls + 1);
      expect(res.json().data.vendors.map((v: { id: string }) => v.id)).toEqual([ids['near']]);
    } finally {
      vi.unstubAllEnvs();
      await late.close();
    }
  });
});
