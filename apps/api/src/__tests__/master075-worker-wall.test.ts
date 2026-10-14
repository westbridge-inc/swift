import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import * as prismaModule from '../plugins/prisma';
import { runWithTenant, runWithoutTenant, scopedPrisma } from '../plugins/prisma';

// ---------------------------------------------------------------------------
// [MASTER-075] The standalone worker is a composition root like the API: it
// builds its database client the SAME way and attests the tenant wall at boot.
//
// worker.ts constructed a raw PrismaClient: none of the API's tenant scoping,
// append-only guard or system-transaction routing, and it never ran the boot
// attestation that refuses an undeclared wall-less production posture or a
// second tenant without a wall. Its jobs depended entirely on database
// permissions and their own predicates. Both roots now share one client
// construction (createScopedProcessClient) and one boot attestation
// (attestTenantWallAtBoot), and the worker attests BEFORE any job runs.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const WORKER = strip(readFileSync(join(SRC, 'worker.ts'), 'utf8'));
const SERVER = strip(readFileSync(join(SRC, 'server.ts'), 'utf8'));

const createScopedProcessClient = (prismaModule as unknown as {
  createScopedProcessClient?: (options: { datasourceUrl: string | undefined }) => PrismaClient;
}).createScopedProcessClient;

describe('[MASTER-075] the worker composition root (source census)', () => {
  it('the worker never constructs a raw database client', () => {
    expect(WORKER).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it('the worker builds its client through the shared construction, sized for the worker', () => {
    expect(WORKER).toMatch(/createScopedProcessClient\(\{\s*datasourceUrl:\s*resolveDatabaseUrl\([^)]*'worker'\)\s*\}\)/);
  });

  it('the worker attests the tenant wall before the job runtime starts', () => {
    const attest = WORKER.indexOf('attestTenantWallAtBoot(');
    const jobs = WORKER.indexOf('initializeJobRuntime(');
    expect(attest).toBeGreaterThan(-1);
    expect(jobs).toBeGreaterThan(-1);
    expect(attest).toBeLessThan(jobs);
  });

  it('the API attests through the same helper, before it listens', () => {
    const attest = SERVER.indexOf('attestTenantWallAtBoot(');
    expect(attest).toBeGreaterThan(-1);
    expect(attest).toBeLessThan(SERVER.indexOf('app.listen('));
  });
});

describe('[MASTER-075] one client construction for every composition root', () => {
  const TENANT_B = `m075-b-${nanoid(6)}`;
  const userIds: string[] = [];
  let worker: PrismaClient;
  let mineId = '';
  let otherId = '';

  beforeAll(async () => {
    expect(typeof createScopedProcessClient).toBe('function');
    worker = createScopedProcessClient!({ datasourceUrl: process.env['DATABASE_URL'] });
    await runWithoutTenant(async () => {
      await scopedPrisma.tenant.create({ data: { id: TENANT_B, name: 'M075 B', slug: TENANT_B, isActive: false } });
      const phone = () => `+5926${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
      const mine = await scopedPrisma.user.create({ data: { phone: phone(), firstName: 'Mine', lastName: 'M075', roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, tenantId: 'swift-default' } });
      const other = await scopedPrisma.user.create({ data: { phone: phone(), firstName: 'Other', lastName: 'M075', roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, tenantId: TENANT_B } });
      mineId = mine.id; otherId = other.id;
      userIds.push(mine.id, other.id);
    });
  });

  afterAll(async () => {
    await runWithoutTenant(async () => {
      await scopedPrisma.user.deleteMany({ where: { id: { in: userIds } } });
      await scopedPrisma.tenant.deleteMany({ where: { id: TENANT_B } });
    });
    await worker?.$disconnect();
  });

  it('a tenant-bound read on the worker client sees only that tenant', async () => {
    const seen = await runWithTenant('swift-default', () => worker.user.findMany({ where: { id: { in: [mineId, otherId] } }, select: { id: true } }));
    expect(seen.map((u) => u.id)).toEqual([mineId]);
  });

  it('a tenant-bound write on the worker client cannot reach another tenant’s row', async () => {
    const moved = await runWithTenant('swift-default', () => worker.user.updateMany({ where: { id: otherId }, data: { lastName: 'Moved' } }));
    expect(moved.count).toBe(0);
    const row = await runWithoutTenant(() => scopedPrisma.user.findUniqueOrThrow({ where: { id: otherId } }));
    expect(row.lastName).toBe('M075');
  });

  it('the worker client keeps the append-only rule on order status logs', async () => {
    await expect(worker.orderStatusLog.deleteMany({ where: { id: `none-${nanoid(6)}` } })).rejects.toThrow(/append-only/);
  });
});

describe('[MASTER-075] the shared boot attestation', () => {
  type Attest = (db: PrismaClient, log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }, env?: Record<string, string | undefined>) => Promise<{ enforced: boolean; bypasses: string[] }>;
  let attest: Attest;
  const lines: string[] = [];
  const log = { info: (_o: object, m: string) => { lines.push(m); }, warn: (_o: object, m: string) => { lines.push(m); } };

  beforeAll(async () => {
    attest = ((await import('../boot/tenant-wall')) as { attestTenantWallAtBoot: Attest }).attestTenantWallAtBoot;
  });

  it('outside production it measures and says the posture, and boots', async () => {
    const rls = await attest(scopedPrisma, log, { NODE_ENV: 'test' });
    expect(typeof rls.enforced).toBe('boolean');
    expect(lines.some((l) => /^tenant wall: (enforced|bypassed\()/.test(l))).toBe(true);
  });

  it('in production an undeclared wall-less posture refuses to start (the test login bypasses the wall)', async () => {
    const rls = await attest(scopedPrisma, log, { NODE_ENV: 'test' });
    expect(rls.enforced).toBe(false); // precondition: the lane login is the table owner / superuser
    await expect(attest(scopedPrisma, log, { NODE_ENV: 'production' })).rejects.toThrow(/FATAL/);
  });
});
