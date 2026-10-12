import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Prisma, TenantKind } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { beginRequestTenantContext, runAsSystem } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';

// DL-7 revision 2: real DB reads, historical cart relations and real sessions.
// The browse interleaving changes a fixture only AFTER the real ID query.
const run = `dl7r2-${nanoid(10).toLowerCase()}`;
const hiddenKinds = ['REVIEW', 'CRAWLER', 'INACTIVE'] as const;
type Store = { id: string; itemId: string; tenantId: string };
type Customer = { id: string; token: string };
const stores: Record<string, Store> = {};
const users: string[] = [];
const tenants: string[] = [];
let seq = 0;
let app: FastifyInstance;
let customer: Customer;
let reviewer: Customer;
const system = <T>(fn: () => Promise<T>) => runAsSystem('dl7r2-fixtures', fn);
const phone = () => `+5926480${String(++seq).padStart(3, '0')}`;

async function makeCustomer(tenantId: string, isSynthetic = false): Promise<Customer> {
  const user = await app.prisma.user.create({ data: {
    phone: phone(), firstName: 'Cart', lastName: 'Customer', tenantId, isSynthetic,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid() });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
    deviceId: run, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return { id: user.id, token };
}

async function makeStore(label: string) {
  const tenantId = `${run}-${label.toLowerCase()}`;
  const isSynthetic = label === 'REVIEW' || label === 'CRAWLER';
  await app.prisma.tenant.create({ data: {
    id: tenantId, slug: tenantId, name: tenantId,
    kind: (label === 'INACTIVE' ? 'PRODUCTION' : label) as TenantKind,
    isActive: label !== 'INACTIVE',
  } });
  tenants.push(tenantId);
  const user = await app.prisma.user.create({ data: {
    phone: phone(), firstName: 'Cart', lastName: 'Owner', tenantId, isSynthetic,
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
  } });
  users.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, tenantId, isSynthetic, name: `${run}-${label}`, slug: tenantId,
    phone: phone(), vendorType: 'SERVICE', status: 'ACTIVE', isVerified: true,
    addressLine1: '1 Test Street', city: 'Georgetown', region: 'Demerara', latitude: 6.8, longitude: -58.15,
    isCurrentlyOpen: true, acceptingOrders: true, averageRating: 4, totalRatings: 7, cuisineTypes: [run],
  } });
  const category = await app.prisma.category.create({ data: { tenantId, vendorId: vendor.id, name: 'Test menu' } });
  const item = await app.prisma.item.create({ data: {
    tenantId, vendorId: vendor.id, categoryId: category.id, name: `${label} service`,
    basePrice: 1000, isAvailable: true, fulfillment: 'APPOINTMENT', stockQuantity: 0,
  } });
  stores[label] = { id: vendor.id, itemId: item.id, tenantId };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await system(async () => {
    for (const label of ['PRODUCTION', ...hiddenKinds]) await makeStore(label);
    customer = await makeCustomer(stores['PRODUCTION']!.tenantId);
    reviewer = await makeCustomer(stores['REVIEW']!.tenantId, true);
    await app.prisma.reviewSession.create({ data: {
      tenantId: stores['REVIEW']!.tenantId, status: 'ANCHORED',
      expiresAt: new Date(Date.now() + 3_600_000), anchorLat: 6.8, anchorLng: -58.15,
      anchorSource: 'DEVICE_GPS', anchoredAt: new Date(),
    } });
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await system(async () => {
    const vendorIds = Object.values(stores).map((s) => s.id);
    await app.prisma.cart.deleteMany({ where: { customerId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: { in: tenants } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });
  await app.close();
  vi.unstubAllEnvs();
});

const get = (url: string, who?: Customer) => app.inject({
  method: 'GET', url: `/api/v1/customer${url}`,
  headers: who ? { authorization: `Bearer ${who.token}` } : {},
});
const add = (store: Store, itemId = store.itemId, who = customer) => app.inject({
  method: 'POST', url: '/api/v1/customer/cart/items',
  headers: { authorization: `Bearer ${who.token}` },
  payload: { vendorId: store.id, itemId, quantity: 2 },
});

async function savedCart(who: Customer, vendor: Store, lines: Store[]) {
  await system(async () => {
    await app.prisma.cart.deleteMany({ where: { customerId: who.id } });
    await app.prisma.cart.create({ data: {
      customerId: who.id, vendorId: vendor.id,
      items: { create: lines.map((s) => ({ itemId: s.itemId, quantity: 1, selectedOptions: {} })) },
    } });
  });
}

describe.each(['log', 'deny'])('DL-7 cart and browse with unscoped access=%s', (mode) => {
  it('cart add hides items exactly like missing items, including deactivation after authentication', async () => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    for (const label of hiddenKinds) {
      const hidden = await add(stores[label]!);
      const missing = await add(stores[label]!, `${run}-missing`);
      expect(missing.statusCode).toBe(404);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual(missing.json());
      expect(hidden.json().error.code).toBe('ITEM_NOT_FOUND');
    }
    // The same stock check remains available inside either caller's tenant.
    for (const [who, store] of [[customer, stores['PRODUCTION']!], [reviewer, stores['REVIEW']!]] as const) {
      const own = await add(store, store.itemId, who);
      expect(own.statusCode, own.body).toBe(409);
      expect(own.json().error.code).toBe('INSUFFICIENT_STOCK');
    }
    // Row tenancy already covers static foreign items. This interleaving
    // requires the vendor relation to recheck the tenant's active state.
    const live = stores['PRODUCTION']!;
    const missing = await add(live, `${run}-missing`);
    const findFirst = app.prisma.item.findFirst.bind(app.prisma.item);
    let deactivated = false;
    // This route awaits the query; it does not use Prisma's fluent relations.
    const spy = vi.spyOn(app.prisma.item, 'findFirst').mockImplementation((async (args: Prisma.ItemFindFirstArgs | undefined) => {
      await system(() => app.prisma.tenant.update({ where: { id: live.tenantId }, data: { isActive: false } }));
      deactivated = true;
      return findFirst(args);
    }) as typeof findFirst);
    try {
      const hidden = await add(live);
      expect(deactivated, 'item lookup reached after authentication').toBe(true);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual(missing.json());
    } finally {
      spy.mockRestore();
      await system(() => app.prisma.tenant.update({ where: { id: live.tenantId }, data: { isActive: true } }));
    }
  });

  it.each(hiddenKinds)('saved cart with a hidden %s tracked store returns an empty cart', async (label) => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    // Visible lines keep this distinct from the nested-item guard.
    await savedCart(customer, stores[label]!, [stores['PRODUCTION']!]);
    const response = await get('/cart', customer);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ success: true, data: null });
    await savedCart(reviewer, stores['REVIEW']!, [stores['REVIEW']!]);
    const own = await get('/cart', reviewer);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data.vendor.id).toBe(stores['REVIEW']!.id);
    expect(own.json().data.items.map((i: { itemId: string }) => i.itemId)).toEqual([stores['REVIEW']!.itemId]);
  });

  it.each(hiddenKinds)('saved cart omits %s lines and prices only visible items', async (label) => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    const live = stores['PRODUCTION']!;
    await savedCart(customer, live, [live]);
    const control = await get('/cart', customer);
    expect(control.statusCode, control.body).toBe(200);
    // Preserve the existing cart/line IDs so the full quote can be compared.
    await system(async () => {
      const cart = await app.prisma.cart.findUniqueOrThrow({ where: { customerId: customer.id } });
      await app.prisma.cartItem.create({ data: {
        cartId: cart.id, itemId: stores[label]!.itemId, quantity: 3, selectedOptions: {},
      } });
    });
    const mixed = await get('/cart', customer);
    expect(mixed.statusCode, mixed.body).toBe(200);
    expect(mixed.json()).toEqual(control.json());
    await savedCart(customer, live, [stores[label]!]);
    const hiddenOnly = await get('/cart', customer);
    expect(hiddenOnly.statusCode, hiddenOnly.body).toBe(200);
    expect(hiddenOnly.json()).toEqual({ success: true, data: null });
  });

  const changes: Array<{ name: string; tenant?: Prisma.TenantUpdateInput; vendor?: Prisma.VendorUpdateInput; item?: Prisma.ItemUpdateInput }> = [
    { name: 'tenant deactivation', tenant: { isActive: false } },
    { name: 'tenant reclassification', tenant: { kind: 'REVIEW' } },
    { name: 'store verification', vendor: { isVerified: false } },
    { name: 'store status', vendor: { status: 'SUSPENDED' } },
    { name: 'type filter', vendor: { vendorType: 'RESTAURANT' } },
    { name: 'cuisine filter', vendor: { cuisineTypes: [] } },
    { name: 'open filter', vendor: { isCurrentlyOpen: false } },
    { name: 'rating filter', vendor: { averageRating: 1 } },
    { name: 'search filter', vendor: { name: 'Changed store' } },
    { name: 'available item filter', item: { isAvailable: false } },
  ];

  const browseCases = changes.flatMap((change) => [
    { ...change, caller: 'guest' },
    // A signed-in caller may still browse their own active REVIEW tenant.
    ...(change.name === 'tenant reclassification' ? [] : [{ ...change, caller: 'customer' }]),
  ]);
  it.each(browseCases)('top_rated $caller rechecks $name after selecting page IDs', async (change) => {
    vi.stubEnv('TENANT_UNSCOPED_ACCESS', mode);
    const live = stores['PRODUCTION']!;
    const url = `/vendors?sort=top_rated&cuisine=${run}&search=${run}-PRODUCTION&type=SERVICE&open=true&minRating=3`;
    const who = change.caller === 'customer' ? customer : undefined;
    const control = await get(url, who);
    expect(control.statusCode, control.body).toBe(200);
    expect(control.json().data.map((v: { id: string }) => v.id)).toEqual([live.id]);
    const findMany = app.prisma.vendor.findMany.bind(app.prisma.vendor);
    let changed = false;
    let reread = false;
    const spy = vi.spyOn(app.prisma.vendor, 'findMany').mockImplementation((async (args: Prisma.VendorFindManyArgs | undefined) => {
      if (changed && !args?.select) reread = true;
      const rows = await findMany(args);
      if (!changed && args?.select?.averageRating && rows.some((v) => v.id === live.id)) {
        changed = true;
        await system(async () => {
          if (change.tenant) await app.prisma.tenant.update({ where: { id: live.tenantId }, data: change.tenant });
          if (change.vendor) await app.prisma.vendor.update({ where: { id: live.id }, data: change.vendor });
          if (change.item) await app.prisma.item.update({ where: { id: live.itemId }, data: change.item });
        });
      }
      return rows;
    }) as typeof findMany);
    try {
      const response = await get(url, who);
      expect(changed, 'fixture changed after the filtered ID read').toBe(true);
      expect(reread, 'the second vendor read was traversed').toBe(true);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual([]);
    } finally {
      spy.mockRestore();
      await system(async () => {
        await app.prisma.tenant.update({ where: { id: live.tenantId }, data: { isActive: true, kind: 'PRODUCTION' } });
        await app.prisma.vendor.update({ where: { id: live.id }, data: {
          isVerified: true, status: 'ACTIVE', vendorType: 'SERVICE', cuisineTypes: [run],
          isCurrentlyOpen: true, averageRating: 4, name: `${run}-PRODUCTION`,
        } });
        await app.prisma.item.update({ where: { id: live.itemId }, data: { isAvailable: true } });
      });
    }
  });
});
