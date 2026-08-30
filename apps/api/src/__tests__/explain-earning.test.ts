import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { explainEarning, gyd } from '../utils/explain-earning';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [ALG-21] A rider's earning, explainable in one sentence.
//
// The number existed; the reason did not. The sentence is generated from the
// same stored fields that produced the number — the amount on the row, the
// frozen billable distance, the express flag, the rail — and never from a
// second computation. The glossary is CI-gated here: "cash in hand", never
// "payout", on any surface a rider reads.
// ---------------------------------------------------------------------------

describe('one sentence from stored fields', () => {
  const cashDelivery = { orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', isExpress: false, billableKm: '2.14', billableKmSource: 'osrm' };

  it('delivery pay: amount, distance with its engine, the rail', () => {
    expect(explainEarning({ type: 'DELIVERY_FEE', amount: '700.00' }, cashDelivery)).toBe('GY$700 — delivery pay for 2.1 km (routed). Cash in hand.');
    expect(explainEarning({ type: 'DELIVERY_FEE', amount: 1050 }, { ...cashDelivery, isExpress: true })).toBe('GY$1,050 — delivery pay for 2.1 km (routed), express. Cash in hand.');
    expect(explainEarning({ type: 'COURIER_FEE', amount: 900 }, { ...cashDelivery, orderType: 'COURIER', billableKmSource: 'haversine' })).toBe('GY$900 — courier pay for 2.1 km (estimated). Cash in hand.');
  });

  it('a distance nobody froze is left out — never invented', () => {
    expect(explainEarning({ type: 'DELIVERY_FEE', amount: 700 }, { orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH' })).toBe('GY$700 — delivery pay. Cash in hand.');
    expect(explainEarning({ type: 'DELIVERY_FEE', amount: 700 }, null)).toBe('GY$700 — delivery pay. Cash in hand.');
  });

  it('the tip, and the fare with a legacy taxi distance', () => {
    expect(explainEarning({ type: 'TIP', amount: 150 }, cashDelivery)).toBe('GY$150 — tip from the customer. Cash in hand.');
    expect(explainEarning({ type: 'TAXI_FARE', amount: 2400 }, { orderType: 'TAXI', paymentMethod: 'CASH', taxiDistance: 5.5 })).toBe('GY$2,400 — fare for 5.5 km (recorded). Cash in hand.');
  });

  it('on the MMG rail the store owes the rider — the sentence says where the money is', () => {
    const mmg = { ...cashDelivery, paymentMethod: 'MOBILE_MONEY' };
    expect(explainEarning({ type: 'DELIVERY_FEE', amount: 700 }, mmg)).toBe('GY$700 — delivery pay for 2.1 km (routed). The store owes you this — settled with the store, not at the door.');
    expect(explainEarning({ type: 'TIP', amount: 150 }, mmg)).toMatch(/^GY\$150 — tip from the customer\. The store owes you this/);
    expect(explainEarning({ type: 'TAXI_FARE', amount: 2400 }, { orderType: 'TAXI', paymentMethod: 'MOBILE_MONEY', taxiDistance: 5.5 })).toBe('GY$2,400 — fare for 5.5 km (recorded). Paid by MMG.');
  });

  it('an unknown type still gets a sentence, and never the forbidden word', () => {
    const s = explainEarning({ type: 'SOMETHING_NEW', amount: 10 }, cashDelivery);
    expect(s).toBe('GY$10 — earning. Cash in hand.');
    expect(gyd('1234.4')).toBe('GY$1,234');
    for (const type of ['DELIVERY_FEE', 'COURIER_FEE', 'TIP', 'TAXI_FARE', 'X']) {
      for (const method of ['CASH', 'MOBILE_MONEY']) {
        expect(explainEarning({ type, amount: 1 }, { ...cashDelivery, paymentMethod: method })).not.toMatch(/payout/i);
      }
    }
  });
});

describe('the glossary is a CI gate: "payout" never reaches a rider', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  it('no mover screen and no earning sentence says "payout"', () => {
    const moverScreens = walk(path.join(__dirname, '..', '..', '..', 'mobile', 'src', 'modules', 'mover'));
    expect(moverScreens.length).toBeGreaterThan(5);
    const offenders = moverScreens.filter((f) => /\bpayouts?\b/i.test(strip(readFileSync(f, 'utf8')))).map((f) => path.relative(process.cwd(), f));
    expect(offenders, 'a rider\'s money is "cash in hand", never a "payout"').toEqual([]);
    expect(strip(readFileSync(path.join(__dirname, '..', 'utils', 'explain-earning.ts'), 'utf8'))).not.toMatch(/'[^']*payout[^']*'|`[^`]*payout[^`]*`/i);
  });

  it('the earnings row renders the server sentence and never rebuilds it', () => {
    const screen = readFileSync(path.join(__dirname, '..', '..', '..', 'mobile', 'src', 'modules', 'mover', 'screens', 'EarningsScreen.tsx'), 'utf8');
    expect(screen).toContain("const sentence = serverText(entry['sentence']);");
    expect(screen).toContain('{sentence ? <T variant="caption">{sentence}</T> : null}');
    expect(screen).not.toMatch(/Cash in hand/); // the words come from the server, one home
  });
});

describe('GET /rider/earnings carries the sentence', () => {
  const PHONE_PREFIX = '+59200658';
  const DAY = 24 * 60 * 60 * 1000;
  let app: FastifyInstance;
  const userIds: string[] = [];
  let vendorId: string;

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.earning.deleteMany({ where: { riderId: { in: riders.map((r) => r.id) } } });
    await app.prisma.order.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riders.map((r) => r.id) } }] } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
    process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.register(riderRoutes, { prefix: '/api/v1/rider' });
    await app.ready();
    await purge();
    const ownerUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}01`, firstName: 'Say', lastName: 'Owner', roles: ['VENDOR_OWNER' as UserRole], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(ownerUser.id);
    const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    vendorId = (await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Sentence Kitchen', slug: `sentence-kitchen-${nanoid(5)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}02`, addressLine1: '1 Word St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } })).id;
  });

  afterAll(async () => {
    await purge();
    await app.close();
  });

  it('every row explains itself from the order it came from', async () => {
    const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}03`, firstName: 'Say', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
    userIds.push(customer.id);
    const riderUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}04`, firstName: 'Say', lastName: 'Rider', roles: ['RIDER'], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(riderUser.id);
    const rider = await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', locationSessionId: syntheticLocationOwner('explain') } });
    const token = app.jwt.sign({ userId: riderUser.id, role: 'RIDER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: riderUser.id, token, refreshToken: nanoid(40), deviceId: 'say', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `SAY-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customer.id, vendorId, riderId: rider.id, status: 'DELIVERED', fulfillment: 'DELIVERY',
        pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 700, tipAmount: 150, totalAmount: 2850, paymentMethod: 'CASH',
        billableKm: 2.14, billableKmSource: 'osrm', isExpress: false,
      },
    });
    await app.prisma.earning.createMany({ data: [
      { riderId: rider.id, orderId: order.id, type: 'DELIVERY_FEE', amount: 700, status: 'AVAILABLE' },
      { riderId: rider.id, orderId: order.id, type: 'TIP', amount: 150, status: 'AVAILABLE' },
    ] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/rider/earnings', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Array<{ type: string; sentence: string }>;
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.sentence]));
    expect(byType['DELIVERY_FEE']).toBe('GY$700 — delivery pay for 2.1 km (routed). Cash in hand.');
    expect(byType['TIP']).toBe('GY$150 — tip from the customer. Cash in hand.');
    expect(res.payload).not.toMatch(/payout/i);
  });
});
