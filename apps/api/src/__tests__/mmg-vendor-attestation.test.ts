import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaymentStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import {
  ATTESTABLE_PAYMENT_STATUSES,
  assertMmgAttestable,
  normaliseMmgReference,
  vendorAttestedCaptures,
} from '../modules/vendor/mmg-attestation';

// ---------------------------------------------------------------------------
// [W-25] "MMG PAYMENT RECEIVED" IS A PERSON'S WORD.
//
// Swift holds no money on this rail: the customer pays the store's own wallet
// and the store says so. The console offered that button on almost every
// order — the predicate was "not captured and not cancelled" — so a payment
// the provider had FAILED, one that had been REFUNDED, and one nobody could
// resolve all had a one-tap "received" with no amount, no recipient and no
// reference. A tap on a reversed payment recaptured a refund.
//
// The matrix below is the exhaustive status test the clause asks for, and the
// reference is the evidence a later reconciliation matches on.
// ---------------------------------------------------------------------------

const ALL_PAYMENT_STATUSES: PaymentStatus[] = [
  'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'UNKNOWN', 'EXPIRED', 'CANCELLED',
];
const REFUSED: Array<[PaymentStatus, string]> = [
  ['FAILED', 'PAYMENT_FAILED'],
  ['REFUNDED', 'PAYMENT_REVERSED'],
  ['PARTIALLY_REFUNDED', 'PAYMENT_REVERSED'],
  ['UNKNOWN', 'PAYMENT_UNRESOLVED'],
  ['EXPIRED', 'PAYMENT_EXPIRED'],
  ['CANCELLED', 'PAYMENT_CANCELLED'],
];

let app: FastifyInstance;
let vendorToken: string;
let vendorId: string;
let customerId: string;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorOwnerId: string;
let seq = 0;
const phoneBase = 592_615_000_000 + Math.floor(Math.random() * 800_000_000);

async function makeUser(roles: string[], activeRole: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Attest',
      lastName: `U${seq}`,
      roles: roles as never,
      activeRole: activeRole as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `attest-${nanoid(8)}`, deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 864e5) },
  });
  return { id: user.id, token };
}

async function makeOrder(paymentStatus: PaymentStatus, status = 'PREPARING') {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `ATT-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status: status as never,
      fulfillment: 'DELIVERY',
      deliveryAddress: 'x',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: 2000,
      subtotalMarkup: 0,
      subtotalCustomer: 2000,
      deliveryFee: 300,
      totalAmount: 2300,
      paymentMethod: 'MOBILE_MONEY',
      paymentStatus,
      mmgRecipientNameSnapshot: 'Attest Diner',
    },
  });
  orderIds.push(order.id);
  return order;
}

const attest = (id: string, reference?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/vendor/orders/${id}/confirm-payment`,
    headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' },
    payload: reference === undefined ? {} : { reference },
  });

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

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorToken = owner.token;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  vendorOwnerId = vo.id;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: 'Attest Diner',
      slug: `attest-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 900}`,
      addressLine1: '1 Wallet St',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: 'ACTIVE',
      isVerified: true,
      acceptingOrders: true,
      isCurrentlyOpen: true,
    },
  });
  vendorId = vendor.id;
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customerId = customer.id;
});

afterAll(async () => {
  await app.prisma.auditLog.deleteMany({ where: { entityId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: vendorOwnerId } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[W-25] the exhaustive payment-state matrix', () => {
  it('every payment state is decided — admissible, idempotent, or refused by name', () => {
    const decided = new Set<string>([...ATTESTABLE_PAYMENT_STATUSES, 'CAPTURED', ...REFUSED.map(([s]) => s)]);
    // the matrix must cover the enum, not a subset someone remembered
    expect([...ALL_PAYMENT_STATUSES].sort()).toEqual([...decided].sort());
    for (const status of ATTESTABLE_PAYMENT_STATUSES) {
      expect(() => assertMmgAttestable({ paymentStatus: status, paymentMethod: 'MOBILE_MONEY', status: 'PREPARING' })).not.toThrow();
    }
    expect(() => assertMmgAttestable({ paymentStatus: 'CAPTURED', paymentMethod: 'MOBILE_MONEY', status: 'PREPARING' })).not.toThrow();
  });

  it.each(REFUSED)('a %s payment cannot be attested (%s), and the order is untouched', async (paymentStatus, code) => {
    const order = await makeOrder(paymentStatus);
    const res = await attest(order.id, `REF${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(code);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe(paymentStatus);
    expect(after.mmgAttestedRef).toBeNull();
    expect(after.mmgAttestedAt).toBeNull();
  });
});

describe('[W-25] the authority is the LOCKED row, not the preview', () => {
  it('the handler re-runs the matrix inside the transaction', () => {
    // A source contract, and it is stated as one. Driving the real race — the
    // payment reversing between the preview read and the row lock — needs a
    // failpoint seam this inline handler does not have, so this proves the
    // second check is PRESENT rather than proving it fires. Deleting it (which
    // is how this regresses) turns this red.
    const route = readFileSync(join(process.cwd(), 'src/modules/vendor/vendor.routes.ts'), 'utf8');
    const capture = route.slice(route.indexOf("confirm-payment'"), route.indexOf('complete-appointment'));
    expect(capture).toMatch(/assertMmgAttestable\(order\)/); // the preview
    expect(capture).toMatch(/assertMmgAttestable\(locked\)/); // the authority
    expect(capture.indexOf('assertMmgAttestable(locked)')).toBeGreaterThan(capture.indexOf('FOR UPDATE'));
  });
});

describe('[W-25] the attestation carries evidence', () => {
  it('refuses without a reference, and refuses one that is not a reference', async () => {
    const order = await makeOrder('PENDING');
    const none = await attest(order.id);
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('REFERENCE_REQUIRED');

    const junk = await attest(order.id, 'a b');
    expect([400]).toContain(junk.statusCode);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe('PENDING');
  });

  it('records who attested, against what reference, for how much and to whom', async () => {
    const order = await makeOrder('PENDING');
    const reference = `MMG${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    const res = await attest(order.id, reference.toLowerCase());
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paymentStatus).toBe('CAPTURED');
    expect(after.mmgAttestedRef).toBe(reference); // stored upper-cased, however it was typed
    expect(after.mmgAttestedAt).not.toBeNull();
    expect(after.mmgAttestedById).not.toBeNull();

    const audit = await app.prisma.auditLog.findFirst({ where: { entityId: order.id, action: 'ATTEST_MMG_PAYMENT' } });
    expect(audit).toBeTruthy();
    const changes = audit!.changes as Record<string, unknown>;
    expect(changes['reference']).toBe(reference);
    expect(String(changes['amount'])).toContain('2300');
    expect(changes['recipient']).toBe('Attest Diner');
    expect(changes['basis']).toBe('VENDOR_ATTESTED');
  });

  it('one payment settles ONE order: the same reference cannot mark a second order paid', async () => {
    const reference = `DUP${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    const first = await makeOrder('PENDING');
    expect((await attest(first.id, reference)).statusCode).toBe(200);

    const second = await makeOrder('PENDING');
    const res = await attest(second.id, reference);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REFERENCE_ALREADY_USED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: second.id } });
    expect(after.paymentStatus).toBe('PENDING');
    expect(after.mmgAttestedRef).toBeNull();
  });

  it('a repeat tap on an already-attested order is still idempotent', async () => {
    const order = await makeOrder('PENDING');
    const reference = `IDEM${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    expect((await attest(order.id, reference)).statusCode).toBe(200);
    const again = await attest(order.id, reference);
    expect(again.statusCode).toBe(200);
    const audits = await app.prisma.auditLog.count({ where: { entityId: order.id, action: 'ATTEST_MMG_PAYMENT' } });
    expect(audits).toBe(1);
  });

  it('the reference itself is normalised, not trusted', () => {
    expect(normaliseMmgReference('  mmg-123abc  ')).toBe('MMG-123ABC');
    for (const bad of ['', 'a', 'ab c', '../etc', "'; drop", 'x'.repeat(65)]) {
      expect(() => normaliseMmgReference(bad), String(bad)).toThrow();
    }
  });
});

describe('[W-25] the register of captures nobody has reconciled', () => {
  it('lists attested captures oldest first, with their age and amount', async () => {
    const order = await makeOrder('PENDING');
    const reference = `SCAN${nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
    expect((await attest(order.id, reference)).statusCode).toBe(200);

    const rows = await vendorAttestedCaptures(app.prisma as never, { limit: 500 });
    const mine = rows.find((r) => r.orderId === order.id);
    expect(mine).toBeTruthy();
    expect(mine!.reference).toBe(reference);
    expect(mine!.amount).toContain('2300');
    expect(mine!.ageHours).toBeGreaterThanOrEqual(0);
  });
});
