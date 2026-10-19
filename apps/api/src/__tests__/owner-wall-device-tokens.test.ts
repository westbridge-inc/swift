/**
 * [item 20 · owner wall] Push registrations (device tokens) are walled to
 * their person (migration 20261018221000_owner_wall_device_tokens), like
 * addresses. Measured through the app's own client on a per-suite walled
 * request login that is a swift_owner_wall member, OWNER_RLS_BIND=1, system
 * work on its bypass-member login:
 *  - fail closed: unbound, and another person's request, see none of a
 *    person's tokens;
 *  - the person registers and unregisters their own; a token still held by
 *    the account last signed in on the device moves to the new account;
 *  - a push sent from SOMEONE ELSE's request still reaches the recipient's
 *    devices (the named capability);
 *  - the five writes that act for someone else inside a transaction (an
 *    admin's ban, session revocations, the erasure) really silence or delete
 *    the target's tokens, through ONE narrow SECURITY DEFINER action each;
 *  - those functions are executable by swift_app only (never PUBLIC), pin
 *    their search_path, and are called from exactly the five known sites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { sessionCredentialDigest } from '../lib/session-credential';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { OWNER_WALL_DEVICE_ACTIONS, readOwnerWallFacts } from '../lib/owner-rls';
import { OWNER_WALL_NOTICE_ACTIONS } from '../lib/owner-wall-notices';
import { OWNER_WALL_TICKET_ACTIONS } from '../lib/owner-wall-tickets';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let requestRole = '';
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { target: '', other: '', admin: '', banned: '', erased: '' };
const tokens = { target: '', other: '' };
const users: string[] = [];

async function sessionFor(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await owner.session.create({ data: {
    // [#1865] A raw client stores what the app stores: the credential digests.
    userId, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), authMethod: 'OTP', deviceId: `owd-${RUN}-${userId.slice(-6)}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  return token;
}
const mkUser = async (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Device', lastName: `Wall${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } })).id;
  users.push(id);
  return id;
};
const device = (userId: string, label: string) => owner.deviceToken.create({ data: { userId, token: `ExponentPushToken[owd-${label}-${RUN}]`, platform: 'ios' } });
const active = (userId: string) => owner.deviceToken.count({ where: { userId, isActive: true } });

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  requestRole = decodeURIComponent(new URL(logins.requestUrl).username);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);

  ids.target = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.other = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.admin = await mkUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });
  ids.banned = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.erased = await mkUser(['CUSTOMER'], 'CUSTOMER');
  await device(ids.target, 'target-a');
  await device(ids.target, 'target-b');
  await device(ids.other, 'other-a');
  await device(ids.banned, 'banned-a');
  await device(ids.banned, 'banned-b');
  await device(ids.erased, 'erased-a');

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { customerRoutes } = await import('../modules/user/customer.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  tokens.target = await sessionFor(ids.target, 'CUSTOMER');
  tokens.other = await sessionFor(ids.other, 'CUSTOMER');
});

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    if (users.length) {
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.deviceToken.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await owner.admin.deleteMany({ where: { userId: { in: users } } });
      await owner.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const call = (method: 'POST' | 'DELETE', url: string, token: string, payload: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
/** A flow bound the way a request is (awaited INSIDE the context: Prisma queries are lazy). */
const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());

describe('[item 20] device tokens: the owner wall fails closed', () => {
  it('unbound, and another person\'s request, see none of a person\'s tokens', async () => {
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      expect(await raw.deviceToken.count({ where: { userId: ids.target } })).toBe(0);
    } finally { await raw.$disconnect(); }
    expect(await asPerson(ids.other, () => app.prisma.deviceToken.count({ where: { userId: ids.target } }))).toBe(0);
    expect(await asPerson(ids.target, () => app.prisma.deviceToken.count({ where: { userId: ids.target } }))).toBe(2);
    expect((await readOwnerWallFacts(app.prisma)).unwalledTables).toEqual([]);
  });
});

describe('[item 20] device tokens: the owner\'s own paths', () => {
  it('registers and unregisters its own device; a token the last account still holds moves to the new one', async () => {
    const fresh = `ExponentPushToken[owd-fresh-${RUN}]`;
    expect((await call('POST', '/api/v1/customer/notifications/devices', tokens.target, { token: fresh, platform: 'ios' })).statusCode).toBe(200);
    expect(await owner.deviceToken.findUnique({ where: { token: fresh } })).toMatchObject({ userId: ids.target, isActive: true });
    // One phone, a new login: the other person's token moves to the account now signed in.
    const handed = `ExponentPushToken[owd-other-a-${RUN}]`;
    expect((await call('POST', '/api/v1/customer/notifications/devices', tokens.target, { token: handed, platform: 'android' })).statusCode).toBe(200);
    expect(await owner.deviceToken.findUnique({ where: { token: handed } })).toMatchObject({ userId: ids.target, isActive: true });
    expect((await call('DELETE', '/api/v1/customer/notifications/devices', tokens.target, { token: fresh })).statusCode).toBe(200);
    expect(await owner.deviceToken.findUnique({ where: { token: fresh } })).toMatchObject({ isActive: false });
  });

  it('a push sent from someone else\'s request still reaches the recipient\'s devices', async () => {
    const sent: string[] = [];
    const channels = {
      push: { sendPush: async (to: string[]) => { sent.push(...to); return { sent: to.length, invalidTokens: [] }; } },
      sms: { sendSms: async () => ({ sent: true }) },
      email: { sendEmail: async () => ({ sent: true }) },
    };
    const { NotificationService } = await import('../modules/notification/notification.service');
    const notices = new NotificationService(app.prisma, app.io, channels as never);
    await asPerson(ids.other, () => notices.send({ userId: ids.target, type: 'ORDER_UPDATE', title: 'Wall', body: `owner wall ${RUN}` }));
    expect(sent).toEqual(expect.arrayContaining([`ExponentPushToken[owd-target-a-${RUN}]`, `ExponentPushToken[owd-target-b-${RUN}]`]));
  });
});

describe('[item 20] device tokens: writes for someone else inside a transaction', () => {
  it('an admin\'s ban silences every registration of the banned account', async () => {
    expect(await active(ids.banned)).toBe(2);
    const { transitionUserStatusAuthority } = await import('../modules/mover-authority');
    await asPerson(ids.admin, () => transitionUserStatusAuthority(app, ids.banned, 'BANNED'));
    expect(await active(ids.banned)).toBe(0);
  });

  it('the erasure, run by the retry job or an admin\'s closure, deletes every registration', async () => {
    expect(await owner.deviceToken.count({ where: { userId: ids.erased } })).toBe(1);
    const { AccountService } = await import('../modules/user/account.service');
    await asPerson(ids.admin, () => new AccountService(app).deleteAccount(ids.erased));
    expect(await owner.deviceToken.count({ where: { userId: ids.erased } })).toBe(0);
  });

  it('the actions are swift_app\'s only (never PUBLIC), pin their search_path and run as their owner', async () => {
    const rows = await owner.$queryRaw<Array<{ name: string; secdef: boolean; config: string[] | null; public_exec: boolean; app_exec: boolean }>>`
      SELECT p.proname::text AS name, p.prosecdef AS secdef, p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
             has_function_privilege('swift_app', p.oid, 'EXECUTE') AS app_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname LIKE 'swift_owner_wall_%' ORDER BY 1`;
    // [item 20 · notifications · support tickets] The notice and ticket actions (owner-wall-notifications) are the only others.
    expect(rows.map((r) => r.name).sort()).toEqual([...OWNER_WALL_DEVICE_ACTIONS, ...OWNER_WALL_NOTICE_ACTIONS, ...OWNER_WALL_TICKET_ACTIONS].sort());
    for (const r of rows) {
      expect(r, r.name).toMatchObject({ secdef: true, public_exec: false, app_exec: true });
      expect(r.config, r.name).toContain('search_path=pg_catalog, public');
    }
  });

  it('the actions are called from exactly the five known sites, and no transaction writes a device token any other way', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(path); }
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(root);
    const calls: Record<string, number> = {};
    const txWrites: string[] = [];
    for (const path of files) {
      const rel = relative(root, path);
      const text = readFileSync(path, 'utf8');
      const n = (text.match(/\b(revokeUserDevices|revokeUserDevice|eraseUserDevices)\(tx,/g) ?? []).length;
      if (n > 0) calls[rel] = n;
      if (rel !== 'lib/owner-rls.ts' && /swift_owner_wall_(revoke|erase)/.test(text)) txWrites.push(`${rel}: calls a device action by name`);
      for (const m of text.matchAll(/\btx\s*\.\s*deviceToken\s*\.\s*(update|updateMany|delete|deleteMany|create|createMany|upsert)\b/g)) txWrites.push(`${rel}: tx.deviceToken.${m[1]}`);
    }
    expect(calls).toEqual({
      'modules/auth/auth.service.ts': 3,
      'modules/mover-authority.ts': 1,
      'modules/user/account.service.ts': 1,
    });
    expect(txWrites).toEqual([]);
  });
});

describe('[item 20 · S4-1] device tokens: the person binding is transaction-local', () => {
  it('a pooled connection that served one person shows the next unbound query none of their tokens', async () => {
    const one = prismaModule.createScopedProcessClient({ datasourceUrl: logins!.singleConnectionUrl });
    try {
      expect(await asPerson(ids.target, () => one.deviceToken.count({ where: { userId: ids.target } }))).toBeGreaterThan(0);
      expect(await one.deviceToken.count({ where: { userId: ids.target } })).toBe(0);
      expect(await asPerson(ids.target, () => one.$transaction((tx) => tx.deviceToken.count({ where: { userId: ids.target } })))).toBeGreaterThan(0);
      expect(await one.deviceToken.count({ where: { userId: ids.target } })).toBe(0);
      expect((await asPerson(ids.target, () => one.$transaction([one.deviceToken.count({ where: { userId: ids.target } })])))[0]).toBeGreaterThan(0);
      expect(await one.deviceToken.count({ where: { userId: ids.target } })).toBe(0);
      expect(await tenant.runWithTenant(PRODUCTION, () => one.deviceToken.count({ where: { userId: ids.target } }))).toBe(0);
    } finally { await one.$disconnect(); }
  });
});
