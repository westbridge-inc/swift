import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [REVIEW-M S3-2 on #2069] The rider loss-protection reserve is a COUNTRY
// ledger: rlp_reserve_entries has no tenant, and production's claim payouts
// draw on it. Like FX and the price book it is platform money, so only the
// canonical tenant's admins may read it or post an entry. Another operator's
// admin pair could do both before (the cross-tenant matrix probe applied a
// GY +1 adjustment and read the whole ledger); now both are refused before
// anything is read or written. The canonical tenant's admins keep exactly the
// access they had (read; adjust with a second person): not founder-only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const TENANT_B = `rlp-tenant-b-${RUN}`;
const NOTE = `RLP tenant suite ${RUN}`;
const REASON = 'Reserve top-up agreed on the owner call, ref RLP-T1';
const READ = '/api/v1/admin/cash-rules/rlp/reserve?country=GY';
const ADJUST = '/api/v1/admin/cash-rules/rlp/reserve/adjust';

let app: FastifyInstance;
const userIds: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:rlp-reserve-tenant');

async function makeAdmin(role: UserRole, tenantId: string): Promise<string> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Reserve', lastName: `Admin${userIds.length}`, roles: [role, 'CUSTOMER'], activeRole: role,
      status: 'ACTIVE', isPhoneVerified: true, tenantId, admin: { create: { permissions: ['*'] } },
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rlp-t-${userIds.length}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return token;
}

const read = (token: string) => app.inject({ method: 'GET', url: READ, headers: { authorization: `Bearer ${token}` } });
const adjust = (token: string, amount: number) => injectWithApproval(app, {
  method: 'POST', url: ADJUST,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  payload: { countryCode: 'GY', amount, note: NOTE },
} as InjectOptions);
const entriesOfThisRun = () => sys(() => app.prisma.rlpReserveEntry.findMany({ where: { note: NOTE } }));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'RLP tenant B', slug: TENANT_B, isActive: true } }));
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await sys(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: userIds } }, { approvedBy: { in: userIds } }] } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:rlp-reserve-tenant').catch(() => 0);
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }).catch(() => {});
  });
  await app.close();
});

describe('[REVIEW-M S3-2 on #2069] the loss-protection reserve belongs to the default tenant', () => {
  it.each(['ADMIN', 'SUPER_ADMIN'] as const)('another operator\'s %s cannot read the GY reserve ledger', async (role) => {
    const token = await makeAdmin(role, TENANT_B);
    const res = await read(token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.message).toBe('Platform controls require the default tenant');
    expect(res.body).not.toContain('balance');
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)('another operator\'s %s cannot post an entry, even with a second admin\'s approval; nothing is written', async (role) => {
    const token = await makeAdmin(role, TENANT_B);
    const res = await adjust(token, 1);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.message).toBe('Platform controls require the default tenant');
    expect(await entriesOfThisRun()).toEqual([]);
  });

  it('control: the default tenant\'s admin still reads the reserve and posts an entry with a second admin', async () => {
    const token = await makeAdmin('ADMIN', 'swift-default');
    const seen = await read(token);
    expect(seen.statusCode, seen.body).toBe(200);
    const posted = await adjust(token, 1);
    expect(posted.statusCode, posted.body).toBe(200);
    expect((await entriesOfThisRun()).map((e) => ({ country: e.countryCode, amount: Number(e.amount), kind: e.kind }))).toEqual([{ country: 'GY', amount: 1, kind: 'ADJUSTMENT' }]);
  });
});
