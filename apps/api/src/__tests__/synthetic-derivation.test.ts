/**
 * [STA-1 DL-4] isSynthetic is a fact of the tenant, held by the database.
 *
 * A user or vendor in a REVIEW (or CRAWLER) tenant IS synthetic — derived on
 * write, whatever the seed said (the default `false` means "unstamped"). A row
 * in a PRODUCTION tenant can never be marked synthetic: refused on insert, on
 * update, and on a tenant move that would carry the flag across. The belt
 * (Tenant.kind) and the braces (isSynthetic) can therefore never disagree, and
 * lib/production-only.ts keeps both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { syntheticDerivationDdl, SYNTHETIC_TABLES } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { REAL_PEOPLE, PRODUCTION_TENANT } from '../lib/production-only';

grantSuiteCapability('ddl');

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const REVIEW = `synth-${RUN}`;
const PRODUCTION = 'swift-default';
let app: FastifyInstance;
const created: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'synthetic-derivation-test');
const user = (tenantId: string, n: number, extra: Record<string, unknown> = {}) =>
  system(async () => { const u = await app.prisma.user.create({ data: { phone: `+59272${NUM}${n}`, firstName: 'S', lastName: 'D', activeRole: 'CUSTOMER', tenantId, ...extra } }); created.push(u.id); return u; });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await installDdl(app.prisma, syntheticDerivationDdl());
  await system(() => app.prisma.tenant.create({ data: { id: REVIEW, name: 'Synthetic fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } }));
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: created } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[STA-1 DL-4] the flag cannot disagree with the tenant', () => {
  it('covers users and vendors', () => {
    expect([...SYNTHETIC_TABLES]).toEqual(['users', 'vendors']);
  });

  it('a person in the fiction is synthetic whether or not the seed said so', async () => {
    expect((await user(REVIEW, 1)).isSynthetic).toBe(true);
    expect((await user(REVIEW, 2, { isSynthetic: false })).isSynthetic).toBe(true);
  });

  it('a person in production is never synthetic: refused on insert and on update', async () => {
    await expect(user(PRODUCTION, 3, { isSynthetic: true })).rejects.toThrow(/STA-1 DL-4/);
    const real = await user(PRODUCTION, 4);
    expect(real.isSynthetic).toBe(false);
    await expect(system(() => app.prisma.user.update({ where: { id: real.id }, data: { isSynthetic: true } }))).rejects.toThrow(/STA-1 DL-4/);
  });

  it('a tenant move cannot carry the flag into production; moving into the fiction derives it', async () => {
    const fiction = await user(REVIEW, 5);
    await expect(system(() => app.prisma.user.update({ where: { id: fiction.id }, data: { tenantId: PRODUCTION } }))).rejects.toThrow(/STA-1 DL-4/);
    const moved = await system(() => app.prisma.user.update({ where: { id: fiction.id }, data: { tenantId: PRODUCTION, isSynthetic: false } }));
    expect(moved.isSynthetic).toBe(false);
    const back = await system(() => app.prisma.user.update({ where: { id: fiction.id }, data: { tenantId: REVIEW } }));
    expect(back.isSynthetic).toBe(true);
  });

  it('the aggregate predicates keep both belt and braces', () => {
    expect(PRODUCTION_TENANT).toEqual({ tenant: { kind: 'PRODUCTION' } });
    expect(REAL_PEOPLE).toEqual({ isSynthetic: false, tenant: { kind: 'PRODUCTION' } });
  });
});
