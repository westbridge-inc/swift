/**
 * [L04 · R1 · OTA-016] The pre-auth identity capability answers WHO and WHICH
 * TENANT — nothing else — and is the one named system work on the sign-in
 * paths.
 *
 *  - Its answers have exactly the identity keys: a widened select (a status,
 *    a role, a hash, a contact detail) turns this red.
 *  - Every read it makes is counted as system work under its own name.
 *  - Its name lives in ONE module, and no session read on a sign-in path joins
 *    through to the account (a join from the unwalled sessions table to the
 *    walled users table would read nothing under the contract posture).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { tenantUnscopedAccessCounter } from '../plugins/observability';
import {
  PREAUTH_IDENTITY_CAPABILITY,
  PUBLIC_SIGNUP_TENANT_ID,
  resolveIdentityByEmail,
  resolveIdentityById,
  resolveIdentityByPhone,
  resolveSessionByRefreshCredential,
} from '../modules/auth/preauth-identity';

let app: FastifyInstance;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PHONE = `+5920008${String(Math.floor(Math.random() * 900) + 100)}`;
const EMAIL = `preauth-${RUN}@example.test`;
let userId = '';
const session = { id: '', token: `tok-${RUN}-${nanoid(16)}`, refreshToken: `rt-${RUN}-${nanoid(32)}`, previous: `prev-${RUN}-${nanoid(32)}` };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:preauth-identity');

const capabilityReads = () => tenantUnscopedAccessCounter.get().then((m) => m.values
  .filter((v) => v.labels['mode'] === 'system' && v.labels['capability'] === PREAUTH_IDENTITY_CAPABILITY)
  .reduce((n, v) => n + v.value, 0));

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  userId = (await system(() => app.prisma.user.create({ data: {
    phone: PHONE, email: EMAIL, firstName: 'Pre', lastName: 'Identity', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    status: 'ACTIVE', isPhoneVerified: true, passwordHash: 'not-a-real-hash',
  } }))).id;
  session.id = (await app.prisma.session.create({ data: {
    userId, token: session.token, refreshToken: session.refreshToken, previousRefreshToken: session.previous,
    deviceId: `preauth-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } })).id;
});

afterAll(async () => {
  await app.prisma.session.deleteMany({ where: { userId } });
  await system(() => app.prisma.user.deleteMany({ where: { id: userId } }));
  await app.close();
});

describe('[L04 · R1] the pre-auth identity capability answers who and which tenant — nothing else', () => {
  it('by phone, by email and by id: exactly {id, tenantId}; an unknown one is null', async () => {
    const byPhone = await resolveIdentityByPhone(app.prisma, PHONE);
    // The fixture account was created with the schema's default tenant: the
    // public sign-up tenant must BE that default (a drift turns this red).
    expect(byPhone).toEqual({ id: userId, tenantId: PUBLIC_SIGNUP_TENANT_ID });
    expect(Object.keys(byPhone!).sort()).toEqual(['id', 'tenantId']);
    const byEmail = await resolveIdentityByEmail(app.prisma, EMAIL);
    expect(Object.keys(byEmail!).sort()).toEqual(['id', 'tenantId']);
    expect(byEmail!.id).toBe(userId);
    const byId = await resolveIdentityById(app.prisma, userId);
    expect(Object.keys(byId!).sort()).toEqual(['id', 'tenantId']);
    expect(byId!.tenantId).toBe('swift-default');
    expect(await resolveIdentityByPhone(app.prisma, '+5920000001')).toBeNull();
    expect(await resolveIdentityById(app.prisma, `missing-${RUN}`)).toBeNull();
  });

  it('by refresh credential (current, or the one just rotated out): exactly {sessionId, userId, tenantId}', async () => {
    const expected = { sessionId: session.id, userId, tenantId: 'swift-default' };
    for (const found of [
      await resolveSessionByRefreshCredential(app.prisma, session.refreshToken),
      await resolveSessionByRefreshCredential(app.prisma, session.previous),
    ]) {
      expect(found).toEqual(expected);
      expect(Object.keys(found!).sort()).toEqual(['sessionId', 'tenantId', 'userId']);
    }
    expect(await resolveSessionByRefreshCredential(app.prisma, `missing-${RUN}`)).toBeNull();
    expect(await resolveSessionByRefreshCredential(app.prisma, '')).toBeNull();
  });

  it('every account read it makes is counted as system work under its own name', async () => {
    const before = await capabilityReads();
    await resolveIdentityByPhone(app.prisma, PHONE);
    await resolveIdentityById(app.prisma, userId);
    await resolveSessionByRefreshCredential(app.prisma, session.refreshToken);
    expect(await capabilityReads()).toBe(before + 3);
  });
});

describe('[L04 · R1] source census', () => {
  const SRC = join(__dirname, '..');
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : files(p);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });

  it('the capability is named in exactly one module', () => {
    const naming = files(SRC).filter((f) => readFileSync(f, 'utf8').includes(`'${PREAUTH_IDENTITY_CAPABILITY}'`));
    expect(naming.map((f) => relative(SRC, f))).toEqual(['modules/auth/preauth-identity.ts']);
  });

  it('no session read on a sign-in path joins through to the account', () => {
    for (const rel of ['plugins/auth.ts', 'plugins/socket.ts', 'modules/auth/auth.service.ts', 'modules/auth/preauth-identity.ts']) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      const reads = [...src.matchAll(/\.session\.find(?:Unique|First)\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]!);
      for (const body of reads) expect(body, `${rel}: a session read selects or includes the account`).not.toMatch(/\buser\s*:/);
    }
  });
});
