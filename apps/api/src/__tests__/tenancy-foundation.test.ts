import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Multi-tenancy foundation (stage 1): the single default tenant exists, every
// tenant-owned root is assigned to it, and a new row auto-inherits it via the
// DB default with no explicit tenantId — the additive, zero-behavior-change
// property that makes this safe to ship before enforcement (stage 2).
// ---------------------------------------------------------------------------

let prisma: PrismaClient;
const cleanupUserIds: string[] = [];

beforeAll(async () => {
  prisma = new PrismaClient({
    datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
  });
});

afterAll(async () => {
  if (cleanupUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe('tenancy foundation', () => {
  it('the single default tenant exists', async () => {
    const t = await prisma.tenant.findUnique({ where: { id: 'swift-default' } });
    expect(t).not.toBeNull();
    expect(t!.slug).toBe('swift');
    expect(t!.isActive).toBe(true);
  });

  it('every seeded user and vendor belongs to an existing tenant', async () => {
    const totalUsers = await prisma.user.count();
    const usersOnDefault = await prisma.user.count({ where: { tenantId: 'swift-default' } });
    const totalVendors = await prisma.vendor.count();
    const vendorsOnDefault = await prisma.vendor.count({ where: { tenantId: 'swift-default' } });
    expect(totalUsers).toBeGreaterThan(0);
    expect(usersOnDefault).toBe(totalUsers);
    expect(vendorsOnDefault).toBe(totalVendors);
    // Every distinct tenantId in use points at a real tenant (FK-backed).
    const distinct = await prisma.user.findMany({ select: { tenantId: true }, distinct: ['tenantId'] });
    for (const row of distinct) {
      const t = await prisma.tenant.findUnique({ where: { id: row.tenantId } });
      expect(t).not.toBeNull();
    }
  });

  it('a new user with NO explicit tenantId inherits the default (additive property)', async () => {
    const u = await prisma.user.create({
      data: {
        phone: `+59264${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Ten', lastName: 'Ant',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true,
      },
    });
    cleanupUserIds.push(u.id);
    expect(u.tenantId).toBe('swift-default');
  });

  it('the tenant relation resolves from a user', async () => {
    const withTenant = await prisma.user.findFirstOrThrow({
      where: { id: cleanupUserIds[0] },
      include: { tenant: true },
    });
    expect(withTenant.tenant.name).toBe('Swift');
  });
});
