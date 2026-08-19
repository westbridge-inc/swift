import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
// Everything from ONE static import of the plugin module so the scoping
// extension and these helpers share the same AsyncLocalStorage instance.
import { getTenantId, prismaPlugin, runWithTenant, runWithoutTenant } from '../plugins/prisma';
import { IdentityService } from '../modules/integrity/identity.service';
import { runIdentityBackfill } from '../modules/integrity/backfill';
import { ensureSan, releaseSan } from '../modules/billing/san.service';

// ---------------------------------------------------------------------------
// Tenant isolation (multi-tenancy stage 2 / launch-readiness §1.2): with a
// tenant bound, every direct operation over tenant-owned models stays inside
// the tenant; writes cannot override or move the tenant; no context remains
// deliberately unscoped for audited background/system work.
// Exercises the REAL extended client from the plugin — production behavior.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let prisma: PrismaClient;
const TENANT_B = `tenant-b-${nanoid(6)}`;
const userIds: string[] = [];

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  prisma = app.prisma;

  // A second tenant + one user in it, created UNSCOPED (the seeding path jobs use).
  await runWithoutTenant(async () => {
    await prisma.tenant.upsert({
      where: { id: TENANT_B }, update: {},
      create: { id: TENANT_B, name: 'Tenant B', slug: `tenant-b-${nanoid(6)}`, isActive: true },
    });
    const uB = await prisma.user.create({
      data: {
        phone: `+59265${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Bee', lastName: 'Tenant',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true, tenantId: TENANT_B,
      },
    });
    userIds.push(uB.id);
  });
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
  await app.close();
});

describe('tenant isolation (stage 2)', () => {
  it('a tenant-B user is invisible to a swift-default-scoped list', async () => {
    const inDefault = await runWithTenant('swift-default', () =>
      prisma.user.findMany({ where: { id: { in: userIds } } }),
    );
    expect(inDefault).toHaveLength(0); // B's user does not exist to the default tenant

    const inB = await runWithTenant(TENANT_B, () =>
      prisma.user.findMany({ where: { id: { in: userIds } } }),
    );
    expect(inB).toHaveLength(1); // but it's fully visible within its own tenant
  });

  it('count is tenant-scoped', async () => {
    const bCount = await runWithTenant(TENANT_B, () => prisma.user.count());
    const defaultCount = await runWithTenant('swift-default', () => prisma.user.count());
    expect(bCount).toBe(1); // exactly the one B user
    expect(defaultCount).toBeGreaterThan(1); // the seed cohort, none of them B
  });

  it('findFirst cannot reach across tenants even by id', async () => {
    const crossed = await runWithTenant('swift-default', () =>
      prisma.user.findFirst({ where: { id: userIds[0] } }),
    );
    expect(crossed).toBeNull(); // default tenant cannot see B's user by its real id
  });

  it('create stamps the active tenant and rejects a caller-supplied override', async () => {
    const created = await runWithTenant(TENANT_B, () =>
      prisma.user.create({
        data: {
          phone: `+59266${String(Math.floor(Math.random() * 90000) + 10000)}`,
          firstName: 'Auto', lastName: 'Stamp',
          roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
          isPhoneVerified: true,
          // A request-controlled tenantId must never win over authenticated
          // context, even if a future route accidentally passes it through.
          tenantId: 'swift-default',
        },
      }),
    );
    userIds.push(created.id);
    expect(created.tenantId).toBe(TENANT_B);
  });

  it('no context = unscoped (background jobs see every tenant)', async () => {
    const all = await runWithoutTenant(() => prisma.user.findMany({ where: { id: { in: userIds } } }));
    expect(all.length).toBe(userIds.length); // every tenant's rows visible
  });

  it('SEC-CT-01: findUnique cannot return another tenant\'s order by its real id', async () => {
    // A tenant-B order (the unassigned kind a mover claims — no owner yet).
    const bOrder = await runWithoutTenant(() =>
      prisma.order.create({
        data: {
          orderNumber: `CT-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: userIds[0]!,
          tenantId: TENANT_B, status: 'READY_FOR_PICKUP',
          pickupAddress: 'B pickup', pickupLat: 6.8, pickupLng: -58.15,
          deliveryAddress: 'B delivery — PII', deliveryLat: 6.81, deliveryLng: -58.16,
          subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
        },
      }),
    );
    try {
      // A tenant-A (default) mover reads the tenant-B order by id.
      const viaFindFirst = await runWithTenant('swift-default', () => prisma.order.findFirst({ where: { id: bOrder.id } }));
      expect(viaFindFirst).toBeNull(); // the FIX: scoped → cannot read another tenant's order

      // Unique identifiers are not authorization. The ORM boundary must apply
      // the same tenant predicate as findFirst.
      const viaFindUnique = await runWithTenant('swift-default', () => prisma.order.findUnique({ where: { id: bOrder.id } }));
      expect(viaFindUnique).toBeNull();
    } finally {
      await runWithoutTenant(() => prisma.order.deleteMany({ where: { id: bOrder.id } }));
    }
  });

  it('findUniqueOrThrow, update and delete fail closed across tenants', async () => {
    const victim = await runWithoutTenant(() =>
      prisma.user.create({
        data: {
          phone: `+59267${String(Math.floor(Math.random() * 90000) + 10000)}`,
          firstName: 'Mutation', lastName: 'Victim',
          roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
          isPhoneVerified: true, tenantId: TENANT_B,
        },
      }),
    );
    userIds.push(victim.id);

    await expect(runWithTenant('swift-default', () =>
      prisma.user.findUniqueOrThrow({ where: { id: victim.id } }),
    )).rejects.toMatchObject({ code: 'P2025' });

    await expect(runWithTenant('swift-default', () =>
      prisma.user.update({ where: { id: victim.id }, data: { firstName: 'CrossTenantWrite' } }),
    )).rejects.toMatchObject({ code: 'P2025' });

    await expect(runWithTenant('swift-default', () =>
      prisma.user.delete({ where: { id: victim.id } }),
    )).rejects.toMatchObject({ code: 'P2025' });

    const untouched = await runWithoutTenant(() => prisma.user.findUniqueOrThrow({ where: { id: victim.id } }));
    expect(untouched.firstName).toBe('Mutation');
    expect(untouched.tenantId).toBe(TENANT_B);
  });

  it('update cannot move a row to another tenant', async () => {
    const owned = await runWithTenant(TENANT_B, () =>
      prisma.user.create({
        data: {
          phone: `+59268${String(Math.floor(Math.random() * 90000) + 10000)}`,
          firstName: 'Stay', lastName: 'Owned',
          roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
          isPhoneVerified: true,
        },
      }),
    );
    userIds.push(owned.id);

    const updated = await runWithTenant(TENANT_B, () =>
      prisma.user.update({
        where: { id: owned.id },
        data: { firstName: 'Still', tenantId: 'swift-default' },
      }),
    );
    expect(updated.firstName).toBe('Still');
    expect(updated.tenantId).toBe(TENANT_B);
  });

  it('bulk creates and updates cannot override the active tenant', async () => {
    const phones = [
      `+59271${String(Math.floor(Math.random() * 90000) + 10000)}`,
      `+59272${String(Math.floor(Math.random() * 90000) + 10000)}`,
    ];
    await runWithTenant(TENANT_B, () => prisma.user.createMany({
      data: phones.map((phone, index) => ({
        phone,
        firstName: `Bulk${index}`,
        lastName: 'Owned',
        roles: ['CUSTOMER'] as never[],
        activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true,
        tenantId: 'swift-default',
      })),
    }));

    const created = await runWithoutTenant(() => prisma.user.findMany({ where: { phone: { in: phones } } }));
    userIds.push(...created.map((user) => user.id));
    expect(created).toHaveLength(2);
    expect(created.every((user) => user.tenantId === TENANT_B)).toBe(true);

    const result = await runWithTenant(TENANT_B, () => prisma.user.updateMany({
      where: { phone: { in: phones } },
      data: { firstName: 'BulkUpdated', tenantId: 'swift-default' },
    }));
    expect(result.count).toBe(2);

    const updated = await runWithoutTenant(() => prisma.user.findMany({ where: { phone: { in: phones } } }));
    expect(updated.every((user) => user.firstName === 'BulkUpdated' && user.tenantId === TENANT_B)).toBe(true);
  });

  it('upsert cannot mutate another tenant and stamps both local branches', async () => {
    const victim = await runWithoutTenant(() => prisma.user.findFirstOrThrow({ where: { tenantId: TENANT_B } }));
    await expect(runWithTenant('swift-default', () => prisma.user.upsert({
      where: { id: victim.id },
      create: {
        id: victim.id,
        phone: `+59273${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'MustNotCreate', lastName: 'Collision',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true, tenantId: TENANT_B,
      },
      update: { firstName: 'MustNotUpdate', tenantId: 'swift-default' },
    }))).rejects.toMatchObject({ code: 'P2025' });
    const untouched = await runWithoutTenant(() => prisma.user.findUniqueOrThrow({ where: { id: victim.id } }));
    expect(untouched.firstName).not.toBe('MustNotUpdate');
    expect(untouched.tenantId).toBe(TENANT_B);

    const localPhone = `+59274${String(Math.floor(Math.random() * 90000) + 10000)}`;
    const created = await runWithTenant(TENANT_B, () => prisma.user.upsert({
      where: { phone: localPhone },
      create: {
        phone: localPhone,
        firstName: 'Upsert', lastName: 'Local',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true, tenantId: 'swift-default',
      },
      update: { tenantId: 'swift-default' },
    }));
    userIds.push(created.id);
    expect(created.tenantId).toBe(TENANT_B);

    const updated = await runWithTenant(TENANT_B, () => prisma.user.upsert({
      where: { phone: localPhone },
      create: {
        phone: localPhone,
        firstName: 'Unused', lastName: 'Create',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true, tenantId: 'swift-default',
      },
      update: { firstName: 'UpsertUpdated', tenantId: 'swift-default' },
    }));
    expect(updated.firstName).toBe('UpsertUpdated');
    expect(updated.tenantId).toBe(TENANT_B);
  });

  it('the global identity union escapes request scoping and records authoritative tenant provenance', async () => {
    const suffix = nanoid(8);
    const [defaultUser, tenantBUser] = await runWithoutTenant(() => prisma.$transaction([
      prisma.user.create({
        data: {
          phone: `+59275${String(Math.floor(Math.random() * 90000) + 10000)}`,
          firstName: 'Global', lastName: 'Default', roles: ['CUSTOMER'] as never[],
          activeRole: 'CUSTOMER' as never, isPhoneVerified: true, tenantId: 'swift-default',
        },
      }),
      prisma.user.create({
        data: {
          phone: `+59276${String(Math.floor(Math.random() * 90000) + 10000)}`,
          firstName: 'Global', lastName: 'TenantB', roles: ['CUSTOMER'] as never[],
          activeRole: 'CUSTOMER' as never, isPhoneVerified: true, tenantId: TENANT_B,
        },
      }),
    ]));
    userIds.push(defaultUser.id, tenantBUser.id);
    const identity = new IdentityService(prisma);
    let clusterA: string | null = null;
    let clusterB: string | null = null;

    try {
      const [createdA, createdB] = await runWithoutTenant(() => prisma.$transaction([
        prisma.identityCluster.create({ data: {} }),
        prisma.identityCluster.create({ data: {} }),
      ]));
      clusterA = createdA.id;
      clusterB = createdB.id;
      await runWithoutTenant(() => prisma.identityClusterMember.createMany({
        data: [
          { accountId: defaultUser.id, clusterId: clusterA!, linkedVia: [] },
          { accountId: tenantBUser.id, clusterId: clusterB!, linkedVia: [] },
        ],
      }));
      expect(clusterA).toBeTruthy();
      expect(clusterB).toBeTruthy();
      expect(clusterA).not.toBe(clusterB);

      const now = new Date();
      await runWithoutTenant(() => prisma.trialGrant.createMany({
        data: [
          {
            tenantId: 'swift-default', clusterId: clusterA!, role: 'VENDOR',
            accountId: defaultUser.id, startedAt: now, endsAt: new Date(now.getTime() + 86_400_000),
          },
          {
            tenantId: TENANT_B, clusterId: clusterB!, role: 'VENDOR',
            accountId: tenantBUser.id, startedAt: now, endsAt: new Date(now.getTime() + 86_400_000),
          },
        ],
      }));

      const shared = `shared-cross-tenant-${suffix}`;
      await runWithTenant('swift-default', async () => {
        const results = await Promise.all([
          identity.capture({
            accountId: defaultUser.id, actorRole: 'CUSTOMER', type: 'PLATE',
            normalizedValue: shared, source: 'TEST_CROSS_TENANT',
          }),
          identity.capture({
            accountId: tenantBUser.id, actorRole: 'CUSTOMER', type: 'PLATE',
            normalizedValue: shared, source: 'TEST_CROSS_TENANT',
          }),
        ]);
        expect(results.some((result) => result.merged)).toBe(true);
      });

      const root = await identity.resolveCluster(defaultUser.id);
      expect(await identity.resolveCluster(tenantBUser.id)).toBe(root);
      const grants = await runWithoutTenant(() => prisma.trialGrant.findMany({
        where: { accountId: { in: [defaultUser.id, tenantBUser.id] } },
        orderBy: { tenantId: 'asc' },
      }));
      expect(grants).toHaveLength(2);
      expect(grants.every((grant) => grant.clusterId === root)).toBe(true);
      expect(new Set(grants.map((grant) => grant.tenantId))).toEqual(new Set(['swift-default', TENANT_B]));

      const tenantBKey = await runWithoutTenant(() => prisma.identityKey.findFirstOrThrow({
        where: { accountId: tenantBUser.id, type: 'PLATE', source: 'TEST_CROSS_TENANT' },
      }));
      expect(tenantBKey.tenantId).toBe(TENANT_B);
    } finally {
      await runWithoutTenant(async () => {
        await prisma.enforcementAction.deleteMany({ where: { accountId: { in: [defaultUser.id, tenantBUser.id] } } });
        await prisma.trialGrant.deleteMany({ where: { accountId: { in: [defaultUser.id, tenantBUser.id] } } });
        await prisma.identityKey.deleteMany({ where: { accountId: { in: [defaultUser.id, tenantBUser.id] } } });
        await prisma.identityClusterMember.deleteMany({ where: { accountId: { in: [defaultUser.id, tenantBUser.id] } } });
        if (clusterA && clusterB) await prisma.identityCluster.deleteMany({ where: { id: { in: [clusterA, clusterB] } } });
      });
    }
  });

  it('the founder identity backfill clears request tenancy for every platform scan', async () => {
    const observed: Array<string | null> = [];
    const see = <T>(value: T) => {
      observed.push(getTenantId());
      return Promise.resolve(value);
    };
    const fake = {
      user: { findMany: () => see([]) },
      driver: { findMany: () => see([]) },
      subscription: { findMany: () => see([]) },
      identityClusterMember: { groupBy: () => see([]) },
    } as unknown as PrismaClient;

    const report = await runWithTenant(TENANT_B, () => runIdentityBackfill(fake));
    expect(report).toMatchObject({ scanned: { users: 0, drivers: 0, mmgRails: 0 }, captured: 0, clusters: [] });
    expect(observed.length).toBeGreaterThanOrEqual(4);
    expect(observed.every((tenantId) => tenantId === null)).toBe(true);
  });

  it('the never-recycle SAN tombstone deny registry is visible across tenants', async () => {
    const suffix = nanoid(8).toLowerCase();
    const ownerUser = await runWithoutTenant(() => prisma.user.create({
      data: {
        phone: `+59277${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'San', lastName: 'TenantB', roles: ['VENDOR_OWNER'] as never[],
        activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true, tenantId: TENANT_B,
      },
    }));
    userIds.push(ownerUser.id);
    const owner = await runWithoutTenant(() => prisma.vendorOwner.create({ data: { userId: ownerUser.id } }));
    const vendor = await runWithoutTenant(() => prisma.vendor.create({
      data: {
        ownerId: owner.id, tenantId: TENANT_B, name: `SAN Tenant B ${suffix}`, slug: `san-tenant-b-${suffix}`,
        vendorType: 'RESTAURANT', phone: `+59278${String(Math.floor(Math.random() * 90000) + 10000)}`,
        addressLine1: '1 Global Registry Road', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
      },
    }));
    const sub = await runWithoutTenant(() => prisma.subscription.create({
      data: {
        vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2_100,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86_400_000),
        nextBillingDate: new Date(Date.now() + 86_400_000), billingMethod: 'CASH',
      },
    }));
    let san: string | null = null;
    try {
      const assignedSan = await runWithTenant(TENANT_B, () => ensureSan(prisma, sub.id));
      san = assignedSan;
      await runWithTenant(TENANT_B, () => releaseSan(prisma, sub.id, 'tenant-isolation-test'));
      const [fromDefault, fromTenantB] = await Promise.all([
        runWithTenant('swift-default', () => prisma.sanTombstone.findUnique({ where: { san: assignedSan } })),
        runWithTenant(TENANT_B, () => prisma.sanTombstone.findUnique({ where: { san: assignedSan } })),
      ]);
      expect(fromDefault?.san).toBe(assignedSan);
      expect(fromTenantB?.san).toBe(assignedSan);
      expect(fromDefault?.tenantId).toBe(TENANT_B);
      expect(fromDefault?.subscriptionId).toBe(sub.id);
      expect((await runWithoutTenant(() => prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }))).san).toBeNull();
    } finally {
      await runWithoutTenant(async () => {
        if (san) await prisma.sanTombstone.deleteMany({ where: { san } });
        await prisma.subscription.deleteMany({ where: { id: sub.id } });
        await prisma.vendor.deleteMany({ where: { id: vendor.id } });
        await prisma.vendorOwner.deleteMany({ where: { id: owner.id } });
      });
    }
  });
});
