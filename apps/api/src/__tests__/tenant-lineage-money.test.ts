/**
 * [STA-1 §4 lineage · money — wave 2] Six money tables are walled on the row
 * itself: transactions, earnings, settlements, delivery_cash_settlements,
 * payout_requests, payout_schedules. Both walls, FORCE, a true backfill, a
 * lineage trigger per table (earnings through their mover to that person),
 * and RLS-N1 for money against a NOBYPASSRLS role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_TABLES, TENANT_LINEAGE_TABLES, allRlsDdl, appRoleDdl, tenantLineageDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const REVIEW = `money-${RUN}`;
const PRODUCTION = 'swift-default';
const PROBE = 'swift_rls_probe';
const TABLES = ['transactions', 'earnings', 'settlements', 'delivery_cash_settlements', 'payout_requests', 'payout_schedules'] as const;
const MODELS = ['transaction', 'earning', 'settlement', 'deliveryCashSettlement', 'payoutRequest', 'payoutSchedule'] as const;
let app: FastifyInstance;
const ids = { reviewUser: '', prodUser: '', reviewRider: '', prodRider: '' };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sta1-money-lineage-test');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await installDdl(app.prisma, [...appRoleDdl(), ...allRlsDdl(), ...tenantLineageDdl()]);
  await installDdl(app.prisma, [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE}') THEN CREATE ROLE ${PROBE} NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO ${PROBE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE}`,
  ]);
  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Money fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    const mk = async (tenantId: string, phone: string) => {
      const u = await app.prisma.user.create({ data: { phone, firstName: 'M', lastName: 'L', activeRole: 'RIDER', tenantId, isSynthetic: tenantId !== PRODUCTION } });
      const r = await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } });
      return { userId: u.id, riderId: r.id };
    };
    const rv = await mk(REVIEW, `+59274${NUM}1`);
    const pr = await mk(PRODUCTION, `+59274${NUM}2`);
    ids.reviewUser = rv.userId; ids.reviewRider = rv.riderId; ids.prodUser = pr.userId; ids.prodRider = pr.riderId;
  });
});

afterAll(async () => {
  await system(async () => {
    const users = [ids.reviewUser, ids.prodUser];
    await app.prisma.earning.deleteMany({ where: { riderId: { in: [ids.reviewRider, ids.prodRider] } } });
    await app.prisma.transaction.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.payoutRequest.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.payoutSchedule.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: [ids.reviewRider, ids.prodRider] } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

const tx = (userId: string, extra: Partial<Prisma.TransactionUncheckedCreateInput> = {}): Prisma.TransactionUncheckedCreateInput =>
  ({ userId, type: 'EARNING_PAYOUT', amount: 1000, direction: 'CREDIT', description: `lineage ${RUN}`, balanceAfter: 1000, ...extra });

describe('[STA-1 §4 lineage · money] six money tables carry their tenant on the row', () => {
  it('all six are in BOTH walls, FORCED, and have a lineage rule', async () => {
    for (const t of TABLES) { expect(TENANT_TABLES).toContain(t); expect(TENANT_LINEAGE_TABLES.map((r) => r.table)).toContain(t); }
    for (const m of MODELS) expect(TENANT_MODEL_NAMES).toContain(m);
    const rows = await app.prisma.$queryRaw<{ relname: string }[]>(Prisma.sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${[...TABLES]}) AND c.relrowsecurity AND c.relforcerowsecurity`);
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
  });

  it('no money row disagrees with its owner about the tenant — the backfill is true', async () => {
    const q = async (sql: Prisma.Sql) => Number((await app.prisma.$queryRaw<{ n: bigint }[]>(sql))[0]!.n);
    expect(await q(Prisma.sql`SELECT count(*)::bigint AS n FROM transactions t JOIN users u ON u.id = t."userId" WHERE t."tenantId" <> u."tenantId"`)).toBe(0);
    expect(await q(Prisma.sql`SELECT count(*)::bigint AS n FROM payout_requests p JOIN users u ON u.id = p."userId" WHERE p."tenantId" <> u."tenantId"`)).toBe(0);
    expect(await q(Prisma.sql`SELECT count(*)::bigint AS n FROM payout_schedules p JOIN users u ON u.id = p."userId" WHERE p."tenantId" <> u."tenantId"`)).toBe(0);
    expect(await q(Prisma.sql`SELECT count(*)::bigint AS n FROM settlements s JOIN vendors v ON v.id = s."vendorId" WHERE s."tenantId" <> v."tenantId"`)).toBe(0);
    expect(await q(Prisma.sql`SELECT count(*)::bigint AS n FROM delivery_cash_settlements d JOIN orders o ON o.id = d."orderId" WHERE d."tenantId" <> o."tenantId"`)).toBe(0);
    expect(await q(Prisma.sql`SELECT count(*)::bigint AS n FROM earnings e JOIN users u ON u.id = COALESCE((SELECT r."userId" FROM riders r WHERE r.id = e."riderId"), (SELECT d."userId" FROM drivers d WHERE d.id = e."driverId")) WHERE e."tenantId" <> u."tenantId"`)).toBe(0);
  });

  it('a bound caller’s transaction is stamped with its tenant; system mode (unstamped) is DERIVED from the owner; an explicit disagreement is refused', async () => {
    const bound = await runWithTenant(REVIEW, () => app.prisma.transaction.create({ data: tx(ids.reviewUser) }));
    expect(bound.tenantId).toBe(REVIEW);
    const derived = await system(() => app.prisma.transaction.create({ data: tx(ids.reviewUser) }));
    expect(derived.tenantId).toBe(REVIEW);
    await expect(runWithTenant(REVIEW, () => app.prisma.transaction.create({ data: tx(ids.prodUser) }))).rejects.toThrow(/STA-1 lineage/);
    await expect(system(() => app.prisma.transaction.create({ data: tx(ids.reviewUser, { tenantId: `other-${RUN}` }) }))).rejects.toThrow(/STA-1 lineage|Foreign key/);
  });

  it('an earning inherits through its mover to that person — two hops — and a mover of another tenant is refused', async () => {
    const e = await system(() => app.prisma.earning.create({ data: { orderId: `order-${RUN}-a`, type: 'DELIVERY_FEE', amount: 500, riderId: ids.reviewRider } }));
    expect(e.tenantId).toBe(REVIEW);
    await expect(runWithTenant(REVIEW, () => app.prisma.earning.create({ data: { orderId: `order-${RUN}-b`, type: 'DELIVERY_FEE', amount: 500, riderId: ids.prodRider } }))).rejects.toThrow(/STA-1 lineage/);
    // an earning with neither rider nor driver has no owner: refused, never stored as production
    await expect(system(() => app.prisma.earning.create({ data: { orderId: `order-${RUN}-c`, type: 'TIP', amount: 100 } }))).rejects.toThrow(/STA-1 lineage/);
  });

  it('payout requests and schedules follow their owner too', async () => {
    const req = await system(() => app.prisma.payoutRequest.create({ data: { userId: ids.reviewUser, amount: 900, netAmount: 900, method: 'MOBILE_MONEY', destination: { phone: 'x' } } }));
    expect(req.tenantId).toBe(REVIEW);
    const sched = await system(() => app.prisma.payoutSchedule.create({ data: { userId: ids.reviewUser, frequency: 'WEEKLY', method: 'MOBILE_MONEY', destination: { phone: 'x' } } }));
    expect(sched.tenantId).toBe(REVIEW);
  });

  it('RLS-N1 for money: bound to production, a NOBYPASSRLS role counts ZERO of the fiction’s transactions; the fiction sees its own', async () => {
    const count = (guc: string) => app.prisma.$transaction(async (t) => {
      await t.$executeRawUnsafe(`SET LOCAL ROLE ${PROBE}`);
      await t.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${guc}'`);
      const rows = await t.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*)::bigint AS n FROM transactions WHERE "userId" = ${ids.reviewUser}`);
      return Number(rows[0]!.n);
    });
    expect(await count(REVIEW)).toBeGreaterThan(0);
    expect(await count(PRODUCTION)).toBe(0);
  });
});
