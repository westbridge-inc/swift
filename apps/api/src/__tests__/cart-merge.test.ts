import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { withSuiteCapability } from '../lib/test-target-lock';
import { beginRequestTenantContext, runAsSystem } from '../plugins/tenant-context';

let app: FastifyInstance;
const people: string[] = [];
const vendors: string[] = [];
const tenants: string[] = [];
let vendorId: string;
let itemId: string;
let soldOutId: string;
let optionItemId: string;
let groupId: string;
let optionId: string;
const phone = () => `+592${Math.floor(100000000 + Math.random() * 899999999)}`;
async function customer(tenantId = 'swift-default') {
  return runAsSystem('cart-merge-fixture', async () => {
  if (tenantId !== 'swift-default') { await app.prisma.tenant.create({ data: { id: tenantId, name: 'Fixture tenant', slug: tenantId } }); tenants.push(tenantId); }
  const u = await app.prisma.user.create({ data: { phone: phone(), firstName: 'Fixture', lastName: 'Basket', tenantId, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } } });
  people.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid() });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'cart-merge-test', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 86400000) } });
  expect(u.tenantId).toBe(tenantId);
  return { id: u.id, token };
  });
}
const line = (extra = {}) => ({ clientLineId: 'line-a', vendorId, itemId, quantity: 2, expectedUnitPrice: 800, selectedOptions: {}, ...extra });
const merge = (token: string, lines: unknown[], key = nanoid(24), extra = {}) => app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: { lines, ...extra } });
const quantity = async (id: string) => (await app.prisma.cartItem.findMany({ where: { cart: { customerId: id } } })).reduce((n, l) => n + l.quantity, 0);
beforeAll(async () => {
  app = Fastify({ logger: false }); registerErrorHandler(app);
  app.addHook('onRequest', (_request, _reply, done) => { beginRequestTenantContext(); done(); });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' }); await app.ready();
  const u = await app.prisma.user.create({ data: { phone: phone(), firstName: 'Fixture', lastName: 'Menu', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } }); people.push(u.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: u.id } });
  for (let i = 0; i < 2; i++) {
    const v = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Fixture Menu', slug: `cart-merge-${nanoid(12).toLowerCase()}`, vendorType: 'RESTAURANT', phone: phone(), addressLine1: 'Fixture area', city: 'Georgetown', region: 'Demerara', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true } }); vendors.push(v.id);
  }
  vendorId = vendors[0]!;
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Menu' } });
  itemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Soup', basePrice: 800, isAvailable: true, stockQuantity: 12 } })).id;
  soldOutId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Gone', basePrice: 400, isAvailable: false } })).id;
  optionItemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Choice', basePrice: 1000 } })).id;
  groupId = (await app.prisma.optionGroup.create({ data: { itemId: optionItemId, name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1 } })).id;
  optionId = (await app.prisma.option.create({ data: { optionGroupId: groupId, name: 'Large', additionalPrice: 300 } })).id;
});
afterAll(async () => {
  if (!app) return;
  await runAsSystem('cart-merge-fixture-cleanup', async () => {
  // Namespace-owned synthetic fixtures only.
  await app.prisma.cart.deleteMany({ where: { customerId: { in: people } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: people } } });
  await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  await app.prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });
  await app.close();
});
describe('guest basket upload', () => {
  it('requires authentication and a bounded idempotency key', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/customer/cart/merge', payload: { lines: [line()] } })).statusCode).toBe(401);
    const c = await customer();
    expect((await merge(c.token, [line()], 'x')).statusCode).toBe(400);
  });
  it('adds every line atomically and replays after cart deletion without re-adding', async () => {
    const c = await customer(); const key = nanoid(24); const lines = [line(), line({ clientLineId: 'choice', itemId: optionItemId, quantity: 1, expectedUnitPrice: 1300, selectedOptions: { [groupId]: optionId } })];
    const first = await merge(c.token, lines, key);
    expect(first.statusCode, first.body).toBe(200); expect(first.json().data).toMatchObject({ applied: true, verdicts: [{ status: 'ADDED' }, { status: 'ADDED' }] });
    expect(await quantity(c.id)).toBe(3);
    await app.prisma.cart.deleteMany({ where: { customerId: c.id } });
    const replay = await merge(c.token, lines, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().data.applied).toBe(true); expect(await quantity(c.id)).toBe(0);
  });
  it('two simultaneous same-key requests add only once', async () => {
    const c = await customer(); const key = nanoid(24);
    const answers = await Promise.all([merge(c.token, [line()], key), merge(c.token, [line()], key)]);
    expect(answers.map(a => a.statusCode)).toEqual([200, 200]); expect(await quantity(c.id)).toBe(2);
  });
  it('refuses a key reused with another body and isolates keys between people', async () => {
    const c = await customer(); const other = await customer(); const key = nanoid(24);
    expect((await merge(c.token, [line()], key)).statusCode).toBe(200);
    expect((await merge(c.token, [line({ quantity: 3 })], key)).statusCode).toBe(409);
    expect((await merge(other.token, [line()], key)).statusCode).toBe(200);
    expect(await quantity(c.id)).toBe(2); expect(await quantity(other.id)).toBe(2);
  });
  it('names unavailable and changed-price lines and writes none of the valid lines', async () => {
    const c = await customer();
    const r = await merge(c.token, [line(), line({ clientLineId: 'gone', itemId: soldOutId }), line({ clientLineId: 'changed', expectedUnitPrice: 1 })]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data).toMatchObject({ applied: false, verdicts: [{ status: 'READY' }, { status: 'UNAVAILABLE' }, { status: 'PRICE_CHANGED', unitPrice: 800 }] });
    expect(await quantity(c.id)).toBe(0);
  });
  it('uses the shared option validator and checks combined stock', async () => {
    const c = await customer();
    const invalid = await merge(c.token, [line({ itemId: optionItemId, expectedUnitPrice: 1000 })]);
    expect(invalid.json().data.verdicts[0].status).toBe('OPTIONS_CHANGED');
    const stock = await merge(c.token, [line({ quantity: 7 }), line({ clientLineId: 'line-b', quantity: 7 })]);
    expect(stock.json().data.applied).toBe(false); expect(stock.json().data.verdicts.every((v: { status: string }) => v.status === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await quantity(c.id)).toBe(0);
  });
  it('never exposes or adds another tenant’s item', async () => {
    const c = await customer(`merge-tenant-${nanoid()}`);
    const r = await merge(c.token, [line()]);
    expect(r.statusCode, r.body).toBe(200); expect(r.json().data.verdicts[0].status).toBe('UNAVAILABLE'); expect(await quantity(c.id)).toBe(0);
  });
  it('asks about a saved cart from a different store without changing it', async () => {
    const c = await customer();
    // A saved cart with a line from the other store: a real choice to make.
    const otherCategory = await app.prisma.category.create({ data: { vendorId: vendors[1]!, name: 'Other menu' } });
    const otherItem = await app.prisma.item.create({ data: { vendorId: vendors[1]!, categoryId: otherCategory.id, name: 'Other soup', basePrice: 500, isAvailable: true } });
    await app.prisma.cart.create({ data: { customerId: c.id, vendorId: vendors[1]!, items: { create: [{ itemId: otherItem.id, quantity: 1, selectedOptions: {} }] } } });
    const r = await merge(c.token, [line()]);
    expect(r.json().data).toMatchObject({ applied: false, verdicts: [{ status: 'DIFFERENT_STORE' }] });
    expect((await app.prisma.cart.findUnique({ where: { customerId: c.id } }))?.vendorId).toBe(vendors[1]);
    expect(await quantity(c.id)).toBe(1);
  });
  it('treats an empty saved cart from another store as no cart: the basket is added and the cart follows this store', async () => {
    const c = await customer();
    await app.prisma.cart.create({ data: { customerId: c.id, vendorId: vendors[1]! } });
    const r = await merge(c.token, [line()]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data).toMatchObject({ applied: true, verdicts: [{ status: 'ADDED' }] });
    expect((await app.prisma.cart.findUnique({ where: { customerId: c.id } }))?.vendorId).toBe(vendorId);
    expect(await quantity(c.id)).toBe(2);
  });
  it('rejects duplicate line identifiers and non-integer or excessive quantities', async () => {
    const c = await customer();
    for (const lines of [[line(), line()], [line({ quantity: 0.5 })], [line({ quantity: 100 })]]) {
      expect((await merge(c.token, lines)).statusCode).toBe(400);
    }
    expect(await quantity(c.id)).toBe(0);
  });  it('rolls back every line if the durable receipt cannot be written', async () => {
    const c = await customer();
    const ddl = (sql: string) => withSuiteCapability('ddl', async () => await app.prisma.$executeRawUnsafe(sql));
    await ddl(`CREATE FUNCTION webb_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt write failure'; END $$`);
    try {
      await ddl('CREATE TRIGGER webb_receipt_fail BEFORE INSERT ON cart_merge_receipts FOR EACH ROW EXECUTE FUNCTION webb_receipt_fail()');
      const r = await merge(c.token, [line(), line({ clientLineId: 'choice', itemId: optionItemId, quantity: 1, expectedUnitPrice: 1300, selectedOptions: { [groupId]: optionId } })]);
      expect(r.statusCode).toBe(500); expect(await quantity(c.id)).toBe(0);
    } finally {
      await ddl('DROP TRIGGER IF EXISTS webb_receipt_fail ON cart_merge_receipts');
      await ddl('DROP FUNCTION webb_receipt_fail()');
    }
  });
  it('caps the combined quantity of one item even when stock is unlimited', async () => {
    const c = await customer();
    const r = await merge(c.token, [line({ itemId: optionItemId, clientLineId: 'one', quantity: 50, expectedUnitPrice: 1300, selectedOptions: { [groupId]: optionId } }), line({ itemId: optionItemId, clientLineId: 'two', quantity: 50, expectedUnitPrice: 1300, selectedOptions: { [groupId]: optionId } })]);
    expect(r.json().data.verdicts.map((v: { status: string }) => v.status)).toEqual(['QUANTITY_LIMIT', 'QUANTITY_LIMIT']);
    expect(await quantity(c.id)).toBe(0);
  });

});
