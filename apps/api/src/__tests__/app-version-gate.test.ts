import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { diffDesired } from '../modules/ops/seed-plan';
import { desiredPlatformConfig } from '../modules/ops/platform-config';
import { MAX_MIN_BUILD, MIN_BUILD_KEYS, minimumBuildOf, readAppVersionPolicy } from '../modules/ops/app-version';
import { cleanupSecondApprovers, injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [Row 3 · force update] The oldest phone build Swift still serves.
//
// Build 12 is the launch build. Without a minimum it can read, no launch build
// could ever be forced off later. The minimum is an OPS setting (two
// PlatformConfig keys the signed spine never names), set from the admin
// console with no deploy and no owner re-seed, and answered on a public,
// uncached route. Builds 9–11 never ask, and no route refuses a request for
// its app version: the answer is advice the newer phones act on.
// ---------------------------------------------------------------------------

const KEYS = [MIN_BUILD_KEYS.ios, MIN_BUILD_KEYS.android];
const RUN = nanoid(6).toLowerCase();
const REASON = 'Force the old launch build off after build 13 went live, ref UPD-1';
const userIds: string[] = [];
let app: FastifyInstance;
let token = '';
let before: Array<{ key: string; value: unknown }> = [];

const policy = async () => {
  const res = await app.inject('/api/v1/public/app-version');
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.json().data;
};
const setMin = (key: string, value: unknown) => injectWithApproval(app, {
  method: 'PUT', url: `/api/v1/admin/config/${key}`,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  payload: { value, reason: REASON } as Record<string, unknown>,
});
const dropKeys = () => runWithoutTenant(() => app.prisma.platformConfig.deleteMany({ where: { key: { in: KEYS } } }), 'test-cleanup:app-version');

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
  // The keys are platform-wide: remember whatever this database held and put it back after.
  before = await runWithoutTenant(() => app.prisma.platformConfig.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true } }), 'test-read');
  await dropKeys();
  const phone = `+59273${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Upd', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'app-version-gate', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  await dropKeys().catch(() => {});
  if (before.length) {
    await runWithoutTenant(() => app.prisma.platformConfig.createMany({ data: before.map((r) => ({ key: r.key, value: r.value as never })) }), 'test-restore').catch(() => {});
  }
  await cleanupSecondApprovers(app);
  await runWithoutTenant(async () => {
    await app.prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: userIds } } }).catch(() => {});
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:app-version').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:app-version').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:app-version');
  await app.close();
});

describe('what counts as a minimum build', () => {
  it.each([
    [12, 12], [1, 1], [MAX_MIN_BUILD, MAX_MIN_BUILD], ['12', 12], [' 8 ', 8],
  ])('%j is a minimum of %j', (value, want) => {
    expect(minimumBuildOf(value)).toBe(want);
  });

  it.each([
    0, -1, 12.5, MAX_MIN_BUILD + 1, Number.NaN, Number.POSITIVE_INFINITY, '', ' ', '12a', '1e3', '-3', null, undefined, true, {}, [12], { minBuild: 12 },
  ])('%j is NO minimum (a cleared or malformed row never blocks every phone)', (value) => {
    expect(minimumBuildOf(value)).toBeNull();
  });

  it('reads both platforms fresh, and only its own two keys', async () => {
    const calls: unknown[] = [];
    const fake = { platformConfig: { findMany: async (args: unknown) => { calls.push(args); return [{ key: MIN_BUILD_KEYS.android, value: 8 }]; } } };
    expect(await readAppVersionPolicy(fake as never)).toEqual({ ios: { minBuild: null }, android: { minBuild: 8 } });
    expect(calls).toEqual([{ where: { key: { in: KEYS } }, select: { key: true, value: true } }]);
  });
});

describe('the public answer', () => {
  it('with nothing set, neither platform has a minimum', async () => {
    expect(await policy()).toEqual({ ios: { minBuild: null }, android: { minBuild: null } });
  });

  it('needs no sign-in: an outdated phone may hold no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/app-version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
  });
});

describe('ops set it from the admin console: no deploy, no re-seed', () => {
  it('a saved minimum is answered at once, per platform; 0 clears it', async () => {
    const ios = await setMin(MIN_BUILD_KEYS.ios, 12);
    expect(ios.statusCode, ios.body).toBe(200);
    expect(await policy()).toEqual({ ios: { minBuild: 12 }, android: { minBuild: null } });

    const android = await setMin(MIN_BUILD_KEYS.android, 8);
    expect(android.statusCode, android.body).toBe(200);
    expect(await policy()).toEqual({ ios: { minBuild: 12 }, android: { minBuild: 8 } });

    const cleared = await setMin(MIN_BUILD_KEYS.ios, 0);
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await policy()).toEqual({ ios: { minBuild: null }, android: { minBuild: 8 } });
  });

  it('every change carries its audit row, with the reason', async () => {
    const rows = await runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { userId: userIds[0]!, entityId: { in: KEYS } },
      select: { entityId: true },
    }), 'test-read');
    expect(rows.filter((r) => r.entityId === MIN_BUILD_KEYS.ios)).toHaveLength(2);
    expect(rows.filter((r) => r.entityId === MIN_BUILD_KEYS.android)).toHaveLength(1);
  });

  it('the signed platform spine never names these keys, so a seed neither plans nor reverts them', async () => {
    const desired = desiredPlatformConfig();
    expect(desired.platformConfig.map((c) => c.key).filter((k) => KEYS.includes(k as never))).toEqual([]);
    // With both set in this database, the seed's own plan touches neither.
    await setMin(MIN_BUILD_KEYS.ios, 13);
    const changes = await runWithoutTenant(() => diffDesired(app.prisma, desired), 'test-seed-plan');
    expect(changes.filter((c) => c.table === 'platformConfig' && KEYS.includes(c.key as never))).toEqual([]);
    expect(await policy()).toEqual({ ios: { minBuild: 13 }, android: { minBuild: 8 } });
  });
});

describe('builds 9–11 are never refused because of it', () => {
  it('with both minimums far above every build, requests that carry no version still succeed', async () => {
    await setMin(MIN_BUILD_KEYS.ios, 999);
    await setMin(MIN_BUILD_KEYS.android, 999);
    expect(await policy()).toEqual({ ios: { minBuild: 999 }, android: { minBuild: 999 } });
    // A guest surface and a signed-in one, as an old phone sends them: no build header at all.
    expect((await app.inject('/api/v1/public/capabilities')).statusCode).toBe(200);
    const signedIn = await app.inject({ method: 'GET', url: '/api/v1/admin/config', headers: { authorization: `Bearer ${token}` } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
  });

  it('nothing but the public answer reads the minimum (no route can refuse by app version)', () => {
    const src = join(process.cwd(), 'src');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
        return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
      });
    })(src);
    expect(files.length).toBeGreaterThan(300);
    const read = (f: string) => readFileSync(f, 'utf8');
    const importers = files.filter((f) => /from '[^']*ops\/app-version'|from '\.\/app-version'/.test(read(f))).map((f) => relative(src, f));
    expect(importers).toEqual(['modules/public/public.routes.ts']);
    const named = files.filter((f) => KEYS.some((k) => read(f).includes(`'${k}'`))).map((f) => relative(src, f));
    expect(named).toEqual(['modules/ops/app-version.ts']);
  });
});
