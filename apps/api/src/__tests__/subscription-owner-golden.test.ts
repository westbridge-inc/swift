import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { wordFreeTag } from './helpers/fixture-ids';
import {
  SUBSCRIPTION_OWNER_JOINS_SQL, SUBSCRIPTION_PAYER_USER_ID_SQL, subscriptionOwnerOf, subscriptionOwnerTenant,
  subscriptionPaidBySql, subscriptionsPaidBy, subscriptionTenantInTx, subscriptionTenantSql, subscriptionTenantWhere,
} from '../modules/subscription/subscription-owner';
import { subscriptionPayer } from '../modules/subscription/mover-fee-authority';

// [BILL-PRO PR0] Golden: the one subscription-owner module answers exactly what
// the inline copies it replaced answered, on real PostgreSQL rows: a store, a
// rider, a driver, one person who is both a rider and a driver, and one person
// who owns a store AND rides. The ORACLE statements below are the replaced
// copies, verbatim; they live only in this test.

const TENANT = 'swift-default';
const PHONE = '+59200574';
const DAY = 86_400_000;
const run = nanoid(7);
let app: FastifyInstance;
const users: string[] = [];
const subs: Record<string, string> = {};
const people: Record<string, string> = {};
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-subscription-owner-golden');
const week = () => ({ status: 'ACTIVE' as const, currencyCode: 'GYD', currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY) });

async function person(roles: string[]) {
  return sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: `${PHONE}${Date.now() % 1_000_000}${users.length}`, firstName: 'Owner', lastName: 'Golden', tenantId: TENANT, countryCode: 'GY',
      roles: roles as never[], activeRole: roles[0] as never, isPhoneVerified: true, selfieCapturedAt: new Date(),
    } });
    users.push(user.id);
    return user.id;
  });
}
const storeSub = (userId: string) => sys(async () => {
  const owner = await app.prisma.vendorOwner.create({ data: { userId } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: `Owner Store ${wordFreeTag(8)}`, slug: `owner-golden-${run.toLowerCase()}-${users.length}`, vendorType: 'RESTAURANT',
    phone: '+5920000574', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } });
  return (await app.prisma.subscription.create({ data: { vendorId: vendor.id, type: 'RESTAURANT', weeklyRate: 6000, ...week() } })).id;
});
const riderSub = (userId: string) => sys(async () => {
  const rider = await app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  return (await app.prisma.subscription.create({ data: { riderId: rider.id, type: 'DELIVERY_RIDER', weeklyRate: 6000, ...week() } })).id;
});
const driverSub = (userId: string) => sys(async () => {
  const driver = await app.prisma.driver.create({ data: { userId, vehicleType: 'CAR', vehicleMake: 'Test', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `HOWN-${run}-${users.length}`,
    driverLicenseUrl: 'storage://test/dl', vehicleInsuranceUrl: 'storage://test/insurance' } });
  return (await app.prisma.subscription.create({ data: { driverId: driver.id, type: 'TAXI_DRIVER', weeklyRate: 9000, ...week() } })).id;
});

// ── The replaced copies (oracles) ───────────────────────────────────────────
const oracleTenant = (id: string) => app.prisma.$queryRaw<Array<{ tenantId: string }>>`
    SELECT u."tenantId" AS "tenantId"
    FROM "subscriptions" s
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    LEFT JOIN "vendors" v ON v."id" = s."vendorId"
    LEFT JOIN "vendor_owners" vo ON vo."id" = v."ownerId"
    JOIN "users" u ON u."id" = COALESCE(r."userId", d."userId", vo."userId")
    WHERE s."id" = ${id}
  `;
const oracleLockSet = (userId: string) => app.prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM subscriptions s
    LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
    LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners o ON o.id=v."ownerId"
    WHERE r."userId"=${userId} OR d."userId"=${userId} OR o."userId"=${userId}
    ORDER BY s.id
  `;
const oracleInvalid = () => app.prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) FROM subscriptions s
    LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
    LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
    LEFT JOIN users u ON u.id=COALESCE(r."userId",d."userId",vo."userId")
    WHERE num_nonnulls(s."riderId",s."driverId",s."vendorId")<>1 OR u.id IS NULL
      OR (v.id IS NOT NULL AND v."tenantId" IS DISTINCT FROM u."tenantId")`;
const oraclePaidBy = (userId: string | { in: string[] }) => ({ OR: [{ rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }] });
const oracleScope = (tenantId: string) => ({ OR: [
  { vendor: { tenantId }, riderId: null, driverId: null },
  { rider: { user: { tenantId } }, vendorId: null, driverId: null },
  { driver: { user: { tenantId } }, vendorId: null, riderId: null },
] });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  people['store owner'] = await person(['VENDOR_OWNER', 'CUSTOMER']);
  subs['store'] = await storeSub(people['store owner']);
  people['rider'] = await person(['MOVER', 'CUSTOMER']);
  subs['rider'] = await riderSub(people['rider']);
  people['driver'] = await person(['MOVER', 'CUSTOMER']);
  subs['driver'] = await driverSub(people['driver']);
  people['rider and driver'] = await person(['MOVER', 'CUSTOMER']);
  subs['rider and driver (rider)'] = await riderSub(people['rider and driver']);
  subs['rider and driver (driver)'] = await driverSub(people['rider and driver']);
  people['store owner who rides'] = await person(['VENDOR_OWNER', 'MOVER', 'CUSTOMER']);
  subs['store owner who rides (store)'] = await storeSub(people['store owner who rides']);
  subs['store owner who rides (rider)'] = await riderSub(people['store owner who rides']);
});

afterAll(async () => {
  await sys(async () => {
    const mine = (await app.prisma.user.findMany({ where: { OR: [{ id: { in: users } }, { phone: { startsWith: PHONE } }] }, select: { id: true } })).map((u) => u.id);
    const ids = (await app.prisma.subscription.findMany({ where: oraclePaidBy({ in: mine }), select: { id: true } })).map((s) => s.id);
    await cleanupPayerBillingClocks(app.prisma, mine);
    await app.prisma.subscription.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: mine } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: mine } } });
    await app.prisma.user.deleteMany({ where: { id: { in: mine } } });
  });
  await app.close();
});

describe('subscription owner: golden against the replaced copies', () => {
  it('the money tenant (subscriptionTenantInTx and the subscriptionTenantSql fragment) equals the old statement for every owner kind', async () => {
    await sys(async () => {
      for (const [name, id] of Object.entries(subs)) {
        const oracle = (await oracleTenant(id))[0]?.tenantId;
        expect(oracle, name).toBe(TENANT);
        expect(await subscriptionTenantInTx(app.prisma, id), name).toBe(oracle);
        const viaFragment = await app.prisma.$queryRaw<Array<{ tenantId: string }>>`
          SELECT u."tenantId" AS "tenantId" FROM "subscriptions" s ${subscriptionTenantSql} WHERE s."id" = ${id}`;
        expect(viaFragment.map((r) => r.tenantId), name).toEqual([oracle]);
      }
      await expect(subscriptionTenantInTx(app.prisma, `missing-${run}`)).rejects.toMatchObject({ code: 'SUBSCRIPTION_TENANT_UNKNOWN' });
    });
  });

  it('the erasure lock set (owner joins + paid-by condition) equals the old statement for every person', async () => {
    await sys(async () => {
      for (const [name, userId] of Object.entries(people)) {
        const oracle = (await oracleLockSet(userId)).map((r) => r.id);
        const now = (await app.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT s.id FROM subscriptions s ${SUBSCRIPTION_OWNER_JOINS_SQL} WHERE ${subscriptionPaidBySql(userId)} ORDER BY s.id`).map((r) => r.id);
        expect(now, name).toEqual(oracle);
        expect(oracle.length, name).toBe(name === 'rider and driver' || name === 'store owner who rides' ? 2 : 1);
      }
    });
  });

  it("the cutover's malformed-owner census counts the same rows", async () => {
    await sys(async () => {
      const now = await app.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM subscriptions s
        ${SUBSCRIPTION_OWNER_JOINS_SQL}
        LEFT JOIN users u ON u.id=${SUBSCRIPTION_PAYER_USER_ID_SQL}
        WHERE num_nonnulls(s."riderId",s."driverId",s."vendorId")<>1 OR u.id IS NULL
          OR (v.id IS NOT NULL AND v."tenantId" IS DISTINCT FROM u."tenantId")`;
      expect(now[0]!.count).toBe((await oracleInvalid())[0]!.count);
    });
  });

  it('the Prisma filters (paid by a person, one-owner tenant scope) select the same rows', async () => {
    await sys(async () => {
      const ids = async (where: Prisma.SubscriptionWhereInput) =>
        (await app.prisma.subscription.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map((s) => s.id);
      for (const [name, userId] of Object.entries(people)) {
        expect(await ids(subscriptionsPaidBy(userId)), name).toEqual(await ids(oraclePaidBy(userId)));
      }
      const everyone = { in: Object.values(people) };
      expect(await ids(subscriptionsPaidBy(everyone))).toEqual(await ids(oraclePaidBy(everyone)));
      expect((await ids(subscriptionsPaidBy(everyone))).sort()).toEqual(Object.values(subs).sort());
      const mine = { id: { in: Object.values(subs) } };
      expect(await ids({ AND: [mine, subscriptionTenantWhere(TENANT)] })).toEqual(await ids({ AND: [mine, oracleScope(TENANT)] }));
      expect(await ids({ AND: [mine, subscriptionTenantWhere(TENANT)] })).toHaveLength(Object.keys(subs).length);
      expect(await ids({ AND: [mine, subscriptionTenantWhere(`other-${run}`)] })).toEqual([]);
    });
  });

  it('subscriptionOwnerOf names the payer the old subscriptionPayer named, and the SAN owner tenant is unchanged', async () => {
    await sys(async () => {
      const expected: Record<string, { kind: string; person: string }> = {
        store: { kind: 'VENDOR', person: 'store owner' },
        rider: { kind: 'RIDER', person: 'rider' },
        driver: { kind: 'DRIVER', person: 'driver' },
        'rider and driver (rider)': { kind: 'RIDER', person: 'rider and driver' },
        'rider and driver (driver)': { kind: 'DRIVER', person: 'rider and driver' },
        'store owner who rides (store)': { kind: 'VENDOR', person: 'store owner who rides' },
        'store owner who rides (rider)': { kind: 'RIDER', person: 'store owner who rides' },
      };
      for (const [name, id] of Object.entries(subs)) {
        const owner = await subscriptionOwnerOf(app.prisma, id);
        expect(owner, name).toMatchObject({ kind: expected[name]!.kind, userId: people[expected[name]!.person], tenantId: TENANT, ownerColumns: 1 });
        expect(!!owner?.vendorId, name).toBe(expected[name]!.kind === 'VENDOR');
        expect(await subscriptionPayer(app.prisma, id), name)
          .toEqual({ userId: people[expected[name]!.person], tenantId: TENANT, kind: expected[name]!.kind === 'VENDOR' ? 'VENDOR' : 'MOVER' });
        expect(await subscriptionOwnerTenant(app.prisma, id), name).toBe(TENANT);
      }
      expect(await subscriptionOwnerOf(app.prisma, `missing-${run}`)).toBeNull();
      await expect(subscriptionPayer(app.prisma, `missing-${run}`)).rejects.toMatchObject({ code: 'MOVER_FEE_OWNERSHIP_INVALID' });
      expect(await subscriptionOwnerTenant(app.prisma, `missing-${run}`)).toBeNull();
    });
  });
});
