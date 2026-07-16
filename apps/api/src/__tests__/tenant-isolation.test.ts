import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
// Everything from ONE static import of the plugin module so the scoping
// extension and these helpers share the same AsyncLocalStorage instance.
import { prismaPlugin, runWithTenant, runWithoutTenant } from '../plugins/prisma';

// ---------------------------------------------------------------------------
// Tenant isolation (multi-tenancy stage 2 / launch-readiness §1.2): with a
// tenant bound, list/count/findFirst over tenant-owned models NEVER span
// tenants; a create stamps the active tenant; no context = unscoped (jobs).
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

  it('create stamps the active tenant automatically', async () => {
    const created = await runWithTenant(TENANT_B, () =>
      prisma.user.create({
        data: {
          phone: `+59266${String(Math.floor(Math.random() * 90000) + 10000)}`,
          firstName: 'Auto', lastName: 'Stamp',
          roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
          isPhoneVerified: true,
          // NOTE: no tenantId given — the context must supply it.
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
});
