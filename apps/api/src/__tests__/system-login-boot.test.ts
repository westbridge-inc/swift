/**
 * [L04 · R1 follow-up] Under the enforced tenant wall the request login reads
 * only the tenant it is bound to, and three things read through the SYSTEM
 * login instead: the account lookup at sign-in (before the tenant is known),
 * SOS escalation, and every system job. If SYSTEM_DATABASE_URL is missing,
 * cannot be reached, or names a login that is not a member of
 * swift_bypass_rls, those reads return nothing: every signed-in user is
 * answered 401, existing users look new, and system work finds no rows. That
 * posture used to boot green.
 *
 * Now the API and the worker refuse to start in it — and only in it. A
 * production deployment whose request login is not walled (today's staging,
 * the declared EXPAND posture) and every non-production mode start exactly as
 * before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { appRoleDdl } from '../lib/tenant-rls';
import { attestationOf, readRlsFacts } from '../lib/rls-attestation';
import { attestSystemLoginAtBoot } from '../boot/system-login';
import { installDdl } from './helpers/install-ddl';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';

// Creates one extra LOGIN role by raw DDL, as the other posture suites do.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const WALL_ON = { NODE_ENV: 'production', TENANT_RLS_BIND: '1', TENANT_UNSCOPED_ACCESS: 'deny' } as const;
const log = { info: () => {}, warn: () => {} };
const urlFor = (role: string, password: string) => {
  const url = new URL(TEST_URL);
  url.username = role;
  url.password = password;
  return url.toString();
};

let owner: PrismaClient;
let request: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>>;
// A login that joins swift_app but NOT swift_bypass_rls: a request-shaped login configured as the system one.
const plainRole = `l04_plain_${randomBytes(6).toString('hex')}`;
const plainPassword = randomBytes(24).toString('hex');

beforeAll(async () => {
  owner = new PrismaClient({ datasourceUrl: TEST_URL });
  await installDdl(owner, appRoleDdl());
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.$executeRawUnsafe(`CREATE ROLE ${plainRole} LOGIN PASSWORD '${plainPassword}' NOBYPASSRLS`);
  await owner.$executeRawUnsafe(`GRANT swift_app TO ${plainRole}`);
  request = new PrismaClient({ datasourceUrl: logins.requestUrl });
});

afterAll(async () => {
  await request?.$disconnect();
  await logins?.cleanup();
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${plainRole}`);
  await owner.$disconnect();
});

describe('a walled API or worker refuses to start without a working system login', () => {
  it('the request login under test really is walled', async () => {
    expect(attestationOf(await readRlsFacts(request)).enforced).toBe(true);
  });

  it('refuses when SYSTEM_DATABASE_URL is not set', async () => {
    await expect(attestSystemLoginAtBoot(request, log, { ...WALL_ON }))
      .rejects.toThrow(/FATAL[\s\S]*SYSTEM_DATABASE_URL is not set/);
  });

  it('refuses when the system login is not a member of swift_bypass_rls', async () => {
    await expect(attestSystemLoginAtBoot(request, log, { ...WALL_ON, SYSTEM_DATABASE_URL: urlFor(plainRole, plainPassword) }))
      .rejects.toThrow(/FATAL[\s\S]*not a member of swift_bypass_rls/);
  });

  it('refuses when the system login is the request login itself', async () => {
    await expect(attestSystemLoginAtBoot(request, log, { ...WALL_ON, SYSTEM_DATABASE_URL: logins.requestUrl }))
      .rejects.toThrow(/FATAL[\s\S]*not a member of swift_bypass_rls/);
  });

  it('refuses when the system login cannot be reached, without printing its address or password', async () => {
    const wrong = urlFor(plainRole, 'not-the-password');
    const err = await attestSystemLoginAtBoot(request, log, { ...WALL_ON, SYSTEM_DATABASE_URL: wrong }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/FATAL[\s\S]*could not be reached/);
    expect(err?.message).not.toContain('not-the-password');
    expect(err?.message).not.toContain(new URL(TEST_URL).host);
  });

  it('starts with a reachable bypass-member system login', async () => {
    await expect(attestSystemLoginAtBoot(request, log, { ...WALL_ON, SYSTEM_DATABASE_URL: logins.systemUrl }))
      .resolves.toBeUndefined();
  });

  it('a production deployment whose request login is not walled (staging today) starts as before, with no system login', async () => {
    expect(attestationOf(await readRlsFacts(owner)).enforced).toBe(false);
    await expect(attestSystemLoginAtBoot(owner, log, { NODE_ENV: 'production', TENANT_WALL_EXPAND_ATTESTED: '1' }))
      .resolves.toBeUndefined();
  });

  it('development and test modes start as before, even on a walled login with no system login', async () => {
    for (const NODE_ENV of ['development', 'test']) {
      await expect(attestSystemLoginAtBoot(request, log, { ...WALL_ON, NODE_ENV })).resolves.toBeUndefined();
    }
  });
});

describe('both composition roots run the check before they serve', () => {
  const source = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');

  it('the API checks before it listens', () => {
    const server = source('server.ts');
    const check = server.indexOf('attestSystemLoginAtBoot(app.prisma');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(server.indexOf('app.listen('));
  });

  it('the worker checks before Redis and its first job', () => {
    const worker = source('worker.ts');
    const check = worker.indexOf('attestSystemLoginAtBoot(prisma');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(worker.indexOf('redis.ping()'));
    expect(check).toBeLessThan(worker.indexOf('initializeJobRuntime({'));
  });
});
