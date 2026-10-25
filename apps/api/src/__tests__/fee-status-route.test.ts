import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { testPhone } from './helpers/fixture-ids';

// [FEE-STATUS · owner 25 Oct 2026] The store's Weekly fee screen said "Nothing due
// right now: your next bill is 13 Oct 2026" on 25 October. GET /subscription now
// carries the server's own words for the fee (billing/fee-status.ts), so no app
// works a passed date into a "next bill" again.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let subscriptionId = '';
const DAY = 86_400_000;
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Fee', lastName: 'Status',
      roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(owner.id);
  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: owner.id, token: vendorToken, refreshToken: nanoid(48),
      deviceId: 'fee-status', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Fee Status Test Store', slug: `fee-status-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920094200', addressLine1: '1 Test Street',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  // The owner's case: the paid week ended 11 days ago and nothing moved the row on.
  const due = new Date(Date.now() - 11 * DAY);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 15_000, currencyCode: 'GYD',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  subscriptionId = sub.id;
});

afterAll(async () => {
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId } });
  await app.prisma.subscription.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

type Payload = { data: { feeStatus?: { state: string; headline: string; detail: string | null; date: string | null }; amountDueGyd: number } };
const read = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/subscription', headers: authed(vendorToken) });
  expect(res.statusCode).toBe(200);
  return (res.json() as Payload).data;
};

describe('GET /vendor/subscription feeStatus [FEE-STATUS]', () => {
  it('a week past its date with nothing received: "Payment due since <date>", never a next bill', async () => {
    const data = await read();
    expect(data.feeStatus?.state).toBe('DUE');
    expect(data.feeStatus?.headline).toMatch(/^Payment due since \d{1,2} [A-Z][a-z]{2,3} \d{4}$/);
    expect(data.feeStatus?.detail).toBe('GY$15,000 to pay.');
  });

  it('the owner\'s store: money already received pays the week, said with the week\'s own date', async () => {
    await app.prisma.prepaidBalance.create({ data: { subscriptionId, balance: 30_000, currencyCode: 'GYD' } });
    const data = await read();
    expect(data.amountDueGyd).toBe(0);
    expect(data.feeStatus?.state).toBe('COVERED');
    expect(data.feeStatus?.headline).toMatch(/^Week from .+ already paid$/);
    expect(JSON.stringify(data.feeStatus)).not.toMatch(/next bill|active until|nothing due/i);
  });

  it('a paid-through date still ahead reads "Paid until <date>"', async () => {
    await app.prisma.subscription.update({ where: { id: subscriptionId }, data: { nextBillingDate: new Date(Date.now() + 3 * DAY) } });
    const data = await read();
    expect(data.feeStatus?.state).toBe('PAID');
    expect(data.feeStatus?.headline).toMatch(/^Paid until /);
  });
});

describe('every partner family sends feeStatus [FEE-STATUS]', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), 'src/modules', p), 'utf8');
  it.each(['vendor/vendor.routes.ts', 'rider/rider.routes.ts', 'driver/driver.routes.ts'])('%s GET /subscription spreads feeStatus from the same payInfo it sends', (file) => {
    const route = src(file).split("'/subscription'")[1]!.split('app.put(')[0]!;
    expect(route).toMatch(/const fee = await payInfo\(app\.prisma, (?:subscription|sub)\)/);
    expect(route).toMatch(/\.\.\.fee,/);
    expect(route).toMatch(/feeStatus: await feeStatusFor\(app\.prisma, (?:subscription|sub), fee/);
  });
});
