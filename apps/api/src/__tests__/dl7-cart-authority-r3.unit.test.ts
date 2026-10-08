import { describe, expect, it, vi } from 'vitest';
import { customerRoutes } from '../modules/user/customer.routes';
import { OrderService } from '../modules/order/order.service';
import { runWithTenant } from '../plugins/tenant-context';
import { hostRoutes, orderStore, prismaDouble, recordingIo, recordingRedis, type Row } from './helpers/service-vertical-doubles';
import { queryRow, type Query } from './helpers/dl7-predicate-double';

// Actual route/service callers, with predicates evaluated against nested rows.
// No middleware, real database, Redis or transaction semantics are certified here.
async function fixture() {
  const vendor: Row = { id: 'vendor-fixture', tenantId: 'tenant-fixture', tenant: { isActive: true, kind: 'PRODUCTION' },
    latitude: 0, longitude: 0, deliveryRadius: 4, name: 'VISIBLE_STORE' };
  const other: Row = { ...vendor, id: 'vendor-other', tenantId: 'tenant-other', name: 'HIDDEN_STORE' };
  const line = (id: string, seller: Row, price: number) => ({ id, quantity: 1,
    item: { id: `item-${id}`, vendorId: seller['id'], vendor: seller, basePrice: price, optionGroups: [] } });
  const cart: Row = { id: 'cart-fixture', customerId: 'user-fixture', vendorId: vendor['id'], vendor, items: [line('visible', vendor, 100), line('hidden', other, 9000)] };
  const promo = { id: 'promo-fixture', code: 'FIXTURE', isActive: true, validFrom: new Date(0), validUntil: new Date('2099-01-01'),
    maxUses: null, currentUses: 0, maxUsesPerUser: 2, vendorId: null, minOrderAmount: null,
    discountType: 'PERCENTAGE', discountValue: 10, maxDiscount: null };
  const address: Row = { id: 'address-fixture', userId: 'user-fixture', latitude: 60, longitude: 60 };
  const update = vi.fn(async () => ({ ...cart }));
  const readVendor = vi.fn(async (q: Query) => queryRow(cart['vendor'] as Row, q));
  const readUser = vi.fn(async () => { throw new Error('VISIBLE_CART_PASSED_AUTHORITY'); });
  const prisma = prismaDouble(orderStore([]), {
    cart: { findUnique: async (q: Query) => queryRow(cart, q), update },
    vendor: { findUnique: readVendor, findFirst: readVendor },
    promoCode: { findUnique: async () => promo }, address: { findFirst: async (q: Query) => queryRow(address, q) },
    user: { findUniqueOrThrow: readUser },
    // Main's identity authority gate on promo: an unclustered account.
    identityClusterMember: { findUnique: async () => null },
  });
  const redis = recordingRedis(); const io = recordingIo();
  const host = await hostRoutes(customerRoutes, { prisma, redis, io });
  const promoRead = () => runWithTenant('tenant-fixture', () => host.call('post /promo/validate', { user: { userId: 'user-fixture' }, body: { code: 'FIXTURE' } }));
  const addressWrite = () => runWithTenant('tenant-fixture', () => host.call('put /cart/address', { user: { userId: 'user-fixture' }, body: { addressId: 'address-fixture' } }));
  const checkout = () => runWithTenant('tenant-fixture', () => new OrderService(prisma, io).checkout({ userId: 'user-fixture', paymentMethod: 'CASH' }));
  return { vendor, other, cart, promo, address, update, readVendor, readUser, promoRead, addressWrite, checkout };
}

describe('DL7 R3 promo caller nested cart wall', () => {
  it('a visible tracked cart counts only its visible lines', async () => {
    const h = await fixture();
    expect(await h.promoRead()).toMatchObject({ data: { estimatedDiscount: 10, applied: true } });
    expect(h.update).toHaveBeenCalledOnce();
  });
  it('an all-hidden cart never leaks its subtotal or applies the promo', async () => {
    const h = await fixture();
    h.cart['items'] = (h.cart['items'] as Row[]).slice(1);
    Object.assign(h.promo, { minOrderAmount: 10_000 });
    expect(await h.promoRead()).toMatchObject({ data: { estimatedDiscount: null, applied: false } });
    expect(h.update).not.toHaveBeenCalled();
  });
  it('a hidden tracked vendor refuses even when an old nested line is visible', async () => {
    const h = await fixture(); h.cart['vendor'] = h.other; h.cart['vendorId'] = h.other['id'];
    expect(await h.promoRead()).toMatchObject({ data: { estimatedDiscount: null, applied: false } });
    expect(h.update).not.toHaveBeenCalled();
  });
  it('a bound REVIEW customer retains the complete same-tenant cart', async () => {
    const h = await fixture();
    h.other['tenantId'] = 'tenant-fixture';
    (h.vendor['tenant'] as Row)['kind'] = 'REVIEW';
    expect(await h.promoRead()).toMatchObject({ data: { estimatedDiscount: 910, applied: true } });
  });
});

describe('DL7 R3 address caller rejects before hidden radius or mutation', () => {
  it.each(['foreign', 'disabled'])('%s tracked store reveals no radius/name and cannot mutate cart', async reason => {
    const h = await fixture();
    if (reason === 'foreign') { h.cart['vendor'] = h.other; h.cart['vendorId'] = h.other['id']; }
    else (h.vendor['tenant'] as Row)['isActive'] = false;
    await expect(h.addressWrite()).rejects.toMatchObject({ code: 'NO_CART' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.readVendor).not.toHaveBeenCalled();
  });
  it('the owned visible store still enforces its delivery radius', async () => {
    const h = await fixture();
    await expect(h.addressWrite()).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.readVendor).toHaveBeenCalledOnce();
  });
  it('foreign address ownership still refuses before cart authority', async () => {
    const h = await fixture(); h.address['userId'] = 'user-other';
    await expect(h.addressWrite()).rejects.toMatchObject({ statusCode: 404 });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.readVendor).not.toHaveBeenCalled();
  });
});

describe('DL7 R3 fresh checkout authority before pricing or named errors', () => {
  it.each(['foreign', 'disabled'])('any %s nested line refuses the whole cart', async reason => {
    const h = await fixture();
    if (reason === 'disabled') { h.other['tenantId'] = 'tenant-fixture'; h.other['tenant'] = { isActive: false, kind: 'PRODUCTION' }; }
    await expect(h.checkout()).rejects.toMatchObject({ code: 'EMPTY_CART' });
    expect(h.readUser).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
  it('a hidden tracked vendor also refuses when all line vendors are visible', async () => {
    const h = await fixture(); h.cart['items'] = (h.cart['items'] as Row[]).slice(0, 1);
    h.cart['vendor'] = h.other; h.cart['vendorId'] = h.other['id'];
    await expect(h.checkout()).rejects.toMatchObject({ code: 'EMPTY_CART' });
    expect(h.readUser).not.toHaveBeenCalled();
  });
  it('same-tenant REVIEW lines pass the new authority boundary without a partial purchase', async () => {
    const h = await fixture(); h.other['tenantId'] = 'tenant-fixture'; (h.vendor['tenant'] as Row)['kind'] = 'REVIEW';
    await expect(h.checkout()).rejects.toThrow('VISIBLE_CART_PASSED_AUTHORITY');
    expect(h.readUser).toHaveBeenCalledOnce();
  });
});
