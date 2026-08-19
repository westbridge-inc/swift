import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { TENANT_TABLES, allRlsDdl } from '../lib/tenant-rls';

// [ELV-1 W-201 stage 1] The database tenant wall, VERIFIED. A NOBYPASSRLS
// probe role stands in for the future app role (CONTRACT stage): through it,
// PostgreSQL itself must show tenant A only A's rows, show NOTHING without
// tenant context (fail closed), and honour the sanctioned bypass — for raw
// SQL exactly as for the ORM, which is the whole point: the wall binds the
// paths application-layer scoping cannot see.
let app: FastifyInstance;
const PROBE_ROLE = 'swift_rls_probe';
const A = `rls-a-${nanoid(6)}`;
const B = `rls-b-${nanoid(6)}`;
let userA: string;
let userB: string;

async function probeCount(guc: Record<string, string>): Promise<number> {
  return app.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
    for (const [k, v] of Object.entries(guc)) {
      await tx.$executeRawUnsafe(`SET LOCAL ${k} = '${v}'`);
    }
    const rows = await tx.$queryRaw<{ n: bigint }[]>(
      Prisma.sql`SELECT count(*)::bigint AS n FROM users WHERE "tenantId" IN (${A}, ${B})`,
    );
    return Number(rows[0]!.n);
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();

  // db-push provisioned environments (CI API tests) carry no migrations —
  // install the wall from the same module the migration froze. Skip when
  // already complete: 51 ALTER TABLEs take brief ACCESS EXCLUSIVE locks the
  // rest of the parallel suite shouldn't have to queue behind.
  const walled = await app.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*)::bigint AS n FROM pg_class c
    JOIN pg_namespace n2 ON n2.oid = c.relnamespace
    JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
    WHERE n2.nspname = 'public' AND c.relrowsecurity AND c.relname = ANY(${[...TENANT_TABLES]})`);
  if (Number(walled[0]!.n) !== TENANT_TABLES.length) {
    for (const ddl of allRlsDdl()) {
      await app.prisma.$executeRawUnsafe(ddl);
    }
  }
  // The probe role: NOBYPASSRLS, not the table owner — the future app role's
  // stand-in. NOLOGIN on purpose; the suite reaches it via SET LOCAL ROLE.
  await app.prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
        CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$`);
  await app.prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`,
  );

  // Two synthetic tenants (tenantId is a real FK), then a user in each —
  // seeded as the owner, which bypasses ENABLEd RLS: stage 1 leaves the app
  // unaffected, and this seeding working IS that proof.
  for (const t of [A, B]) {
    await app.prisma.tenant.create({ data: { id: t, name: `RLS probe ${t}`, slug: t } });
  }
  const mk = (tenantId: string) => app.prisma.user.create({
    data: {
      phone: `+59200RLS${nanoid(6)}`,
      firstName: 'Wall', lastName: tenantId,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      tenantId,
    },
    select: { id: true },
  });
  userA = (await mk(A)).id;
  userB = (await mk(B)).id;
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { tenantId: { in: [A, B] } } });
  await app.prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
  await app.close();
});

describe('database tenant wall [W-201 / F-201]', () => {
  it('census: every tenantId-bearing model in the schema is walled — no stragglers', () => {
    const dmmfTables = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
      .map((m) => m.dbName || m.name)
      .sort();
    expect(dmmfTables).toEqual([...TENANT_TABLES].sort());
  });

  it('RLS is ENABLED with the policy present on all 51 tables', async () => {
    const rows = await app.prisma.$queryRaw<{ relname: string }[]>(Prisma.sql`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
      WHERE n.nspname = 'public' AND c.relname = ANY(${[...TENANT_TABLES]})
        AND (NOT c.relrowsecurity OR p.oid IS NULL)`);
    expect(rows).toEqual([]);
  });

  it('tenant A sees ONLY tenant A — through raw SQL, the path app scoping cannot reach', async () => {
    expect(await probeCount({ 'app.current_tenant': A })).toBe(1);
    expect(await probeCount({ 'app.current_tenant': B })).toBe(1);
  });

  it('NO tenant context sees NOTHING — the wall fails closed', async () => {
    expect(await probeCount({})).toBe(0);
  });

  it('the sanctioned bypass GUC sees everything (system/admin work)', async () => {
    expect(await probeCount({ 'app.bypass_tenant': 'on' })).toBe(2);
  });

  it('writes are walled too: A cannot touch B rows, and cannot INSERT into B', async () => {
    // UPDATE across the wall: B's row is invisible → 0 rows affected.
    const touchedB = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${A}'`);
      return tx.$executeRaw(Prisma.sql`UPDATE users SET "firstName" = 'X' WHERE id = ${userB}`);
    });
    expect(touchedB).toBe(0);
    const touchedA = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${A}'`);
      return tx.$executeRaw(Prisma.sql`UPDATE users SET "firstName" = 'Walled' WHERE id = ${userA}`);
    });
    expect(touchedA).toBe(1);

    // INSERT wearing the wrong tenant: WITH CHECK refuses the row outright.
    await expect(app.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE_ROLE}`);
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${A}'`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO users (id, phone, "firstName", "lastName", "activeRole", "updatedAt", "tenantId")
        VALUES (${`rls-smuggle-${nanoid(8)}`}, ${`+59200RLS${nanoid(6)}`}, 'Smuggle', 'Attempt', 'CUSTOMER', now(), ${B})`);
    })).rejects.toThrow(/row-level security policy/);
  });

  it('stage 1 leaves the OWNER (today\'s app role) unaffected — no behavior change until CONTRACT', async () => {
    const both = await app.prisma.user.count({ where: { tenantId: { in: [A, B] } } });
    expect(both).toBe(2);
  });
});
