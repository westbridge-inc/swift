/**
 * [row 622 · #1890 review S4-1] The two account-erasure actions of the owner wall
 * (swift_owner_wall_erase_devices, swift_owner_wall_erase_notices) are SECURITY DEFINER and swift_app may
 * execute them. Before this, ANY swift_app session could empty any person's inbox and push registrations by
 * id. They now refuse unless the person's account carries the erasure tombstone (users.phone =
 * 'deleted:' || id, the exact erasure marker: a status alone can be replaced by a later ban). The closure
 * writes that tombstone FIRST in its transaction (moved up from right after the cleanup: same transaction,
 * so the same commit). Measured on a walled request login (OWNER_RLS_BIND=1):
 *  - refused outside an erasure: a raw swift_app session, and the helpers inside an admin's transaction,
 *    also for a DEACTIVATED account that is not erased;
 *  - the erasure still removes everything: the first pass (an admin's closure, the person's own, a job bound
 *    to the tenant only) and the re-sweep of a closed account (late rows);
 *  - pinned: nothing between the tombstone's new place and its old one reads users.status or users.phone
 *    (the code, and the triggers on the tables that step writes), and the functions read users only for the
 *    guard. One exception, by design: #1984's off-site erasure ledger. Its row capture reads the tombstone,
 *    so the first pass now also ledgers every row its cleanup removes ('deleted_rows'); it only appends to
 *    the ledger. Its closed-account entry needs the complete tombstone (checked with a person already named
 *    'Deleted User', for whom it fires at the cut-off: the restore's rule still keeps none of the removed rows).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const REFUSED = /not in erasure/;

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { admin: '', live: '', deactivated: '', byAdmin: '', own: '', byJob: '', namedDeleted: '' };
const users: string[] = [];

const mkUser = async (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Erase', lastName: `Guard${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION, ...extra,
  } })).id;
  users.push(id);
  return id;
};
/** The ids of what `seed` wrote, per person: the off-site ledger names removed rows by table and id. */
const seeded: Record<string, Array<{ tbl: string; id: string }>> = {};
/** One inbox notice and one push registration of `userId` (written as the owner, past the wall). */
const seed = async (userId: string, label: string) => {
  const notice = await owner.notification.create({ data: { userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Guard', body: `guard-${label}-${RUN}` } });
  const device = await owner.deviceToken.create({ data: { userId, token: `ExponentPushToken[oweg-${label}-${RUN}]`, platform: 'ios' } });
  (seeded[userId] ??= []).push({ tbl: 'notifications', id: notice.id }, { tbl: 'device_tokens', id: device.id });
};
type LedgerEntry = { kind: string; entry: { tbl?: string; id?: string; kept?: Array<{ tbl: string; id: string }> } };
/** [#1984] The off-site erasure ledger's entries about `userId`'s account and the seeded rows. */
const ledgerOf = async (userId: string) => {
  const rowIds = (seeded[userId] ?? []).map((r) => r.id);
  return owner.$queryRaw<LedgerEntry[]>`
    SELECT kind, entry FROM erasure_ledger_entry
     WHERE (kind = 'closed_accounts' AND entry->>'id' = ${userId}) OR (kind = 'deleted_rows' AND entry->>'id' = ANY(${rowIds}::text[]))
     ORDER BY "createdAt", id`;
};
/** The restore's own rule (deploy/restore-offsite-ledger.sql): kept = every tombstone entry's list minus the deleted rows. */
const restoreKeeps = (rows: LedgerEntry[]) => {
  const gone = new Set(rows.filter((r) => r.kind === 'deleted_rows').map((r) => `${r.entry.tbl}/${r.entry.id}`));
  return rows.filter((r) => r.kind === 'closed_accounts').flatMap((r) => r.entry.kept ?? []).filter((k) => !gone.has(`${k.tbl}/${k.id}`));
};
const held = async (userId: string) => ({
  notices: await owner.notification.count({ where: { userId } }),
  devices: await owner.deviceToken.count({ where: { userId } }),
});

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  const requestRole = decodeURIComponent(new URL(logins.requestUrl).username);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);

  ids.admin = await mkUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });
  ids.live = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.deactivated = await mkUser(['CUSTOMER'], 'CUSTOMER', { status: 'DEACTIVATED' });
  ids.byAdmin = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.own = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.byJob = await mkUser(['CUSTOMER'], 'CUSTOMER');
  // [#1984] A person whose own row already reads as the complete tombstone (named 'Deleted User', no email, no
  // password, no location): the ledger's closed-account trigger fires at the cut-off write, before the cleanup.
  ids.namedDeleted = await mkUser(['CUSTOMER'], 'CUSTOMER', { firstName: 'Deleted', lastName: 'User' });
  for (const [key, id] of Object.entries(ids)) if (key !== 'admin') await seed(id, key);

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
  app = Fastify({ logger: false });
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
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

/** A flow bound the way a request is (awaited INSIDE the context: Prisma queries are lazy). */
const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());
const closeAccount = async (userId: string, selfServe = false) => {
  const { AccountService } = await import('../modules/user/account.service');
  return new AccountService(app).deleteAccount(userId, selfServe);
};

describe('[row 622] the erase actions refuse outside an erasure', () => {
  it('a raw swift_app session cannot empty a live person\'s inbox or push registrations by id', async () => {
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      await expect(raw.$queryRaw`SELECT public.swift_owner_wall_erase_notices(${ids.live}) AS n`).rejects.toThrow(REFUSED);
      await expect(raw.$queryRaw`SELECT public.swift_owner_wall_erase_devices(${ids.live}) AS n`).rejects.toThrow(REFUSED);
    } finally { await raw.$disconnect(); }
    expect(await held(ids.live)).toEqual({ notices: 1, devices: 1 });
  });

  it('inside an admin\'s transaction the helpers are refused for an account that is not erased, even a DEACTIVATED one', async () => {
    const { eraseOwedRowsInTransaction } = await import('../modules/user/erasure-coverage');
    const { eraseUserDevices } = await import('../lib/owner-rls');
    for (const person of [ids.live, ids.deactivated]) {
      await expect(asPerson(ids.admin, () => app.prisma.$transaction((tx) => eraseUserDevices(tx, person)))).rejects.toThrow(REFUSED);
      await expect(asPerson(ids.admin, () => app.prisma.$transaction((tx) => eraseOwedRowsInTransaction(tx, person)))).rejects.toThrow(REFUSED);
      expect(await held(person), person).toEqual({ notices: 1, devices: 1 });
    }
  });
});

describe('[row 622] the erasure still removes everything', () => {
  it('the first pass: an admin\'s closure, the person\'s own and a job bound to the tenant only', async () => {
    await asPerson(ids.admin, () => closeAccount(ids.byAdmin));
    await asPerson(ids.own, () => closeAccount(ids.own, true));
    await tenant.runWithTenant(PRODUCTION, () => closeAccount(ids.byJob));
    for (const person of [ids.byAdmin, ids.own, ids.byJob]) {
      expect(await held(person), person).toEqual({ notices: 0, devices: 0 });
      expect(await owner.user.findUniqueOrThrow({ where: { id: person } }), person).toMatchObject({ status: 'DEACTIVATED', phone: `deleted:${person}` });
      // [#1984] The tombstone comes first, so the off-site ledger names every row the cleanup removed, and the
      // closed-account entry (the complete tombstone, after the cleanup) keeps none of them.
      const ledger = await ledgerOf(person);
      expect(ledger.filter((r) => r.kind === 'deleted_rows').map((r) => ({ tbl: r.entry.tbl, id: r.entry.id })), person)
        .toEqual(expect.arrayContaining(seeded[person]!));
      expect(ledger.filter((r) => r.kind === 'closed_accounts'), person).toHaveLength(1);
      expect(restoreKeeps(ledger), person).toEqual([]);
    }
  });

  it('[#1984] a person already named \'Deleted User\': the early closed-account entry keeps rows the cleanup then removes, and each is ledgered as deleted', async () => {
    await asPerson(ids.admin, () => closeAccount(ids.namedDeleted));
    expect(await held(ids.namedDeleted)).toEqual({ notices: 0, devices: 0 });
    const ledger = await ledgerOf(ids.namedDeleted);
    const [early] = ledger.filter((r) => r.kind === 'closed_accounts');
    // The edge is real: the cut-off write fired the entry before the cleanup, so it lists the seeded rows as kept.
    expect(early!.entry.kept, 'early entry').toEqual(expect.arrayContaining(seeded[ids.namedDeleted]!));
    expect(ledger.filter((r) => r.kind === 'deleted_rows').map((r) => ({ tbl: r.entry.tbl, id: r.entry.id })))
      .toEqual(expect.arrayContaining(seeded[ids.namedDeleted]!));
    expect(restoreKeeps(ledger)).toEqual([]);
  });

  it('the re-sweep: a closed account\'s late notice and registration go when the closure runs again (the retry job, an admin)', async () => {
    await seed(ids.byAdmin, 'late-job');
    await tenant.runWithTenant(PRODUCTION, () => closeAccount(ids.byAdmin));
    expect(await held(ids.byAdmin)).toEqual({ notices: 0, devices: 0 });
    await seed(ids.byAdmin, 'late-admin');
    await asPerson(ids.admin, () => closeAccount(ids.byAdmin));
    expect(await held(ids.byAdmin)).toEqual({ notices: 0, devices: 0 });
  });
});

const API = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(API, rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** The body of `head` up to the first line that closes it at `indent`. */
const bodyOf = (text: string, head: string, close: string) => {
  const at = text.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  const end = text.indexOf(close, at);
  expect(end, head).toBeGreaterThan(at);
  return text.slice(at + head.length, end);
};
const awaited = (body: string) => [...stripComments(body).matchAll(/await\s+([\w.]+)\(/g)].map((m) => m[1]!);

describe('[row 622] pinned: nothing between the tombstone and its old place reads users.status or users.phone', () => {
  const account = read('modules/user/account.service.ts');

  it('the first pass writes the tombstone, then runs the cleanup, then its cut-off audit row, then returns; the re-sweep runs it only on a tombstoned account', () => {
    const tombstone = 'data: { status: \'DEACTIVATED\', phone: `deleted:${userId}`, avatar: null },\n      });';
    const at = account.indexOf(tombstone);
    expect(at, 'the first pass tombstone').toBeGreaterThan(-1);
    expect(account.indexOf(tombstone, at + 1), 'one tombstone write in deleteAccount').toBe(-1);
    const next = stripComments(account.slice(at + tombstone.length, account.indexOf('return { hold,', at)))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    // [#1945] The erasure's cut-off audit row stays AFTER the cleanup, where it was: swift_erased_person (the
    // database's erasure exceptions) needs that row, so it stays false during the cleanup exactly as before.
    expect(next).toEqual([
      'await revokeAccessBeforeCleanup();',
      'await tx.auditLog.create({ data: { userId, action: ACCOUNT_ERASURE_CUTOFF, entity: \'User\', entityId: userId } });',
    ]);
    const resweep = bodyOf(account, 'if (user.phone === `deleted:${userId}`) {', '\n      }\n');
    expect(awaited(resweep)).toContain('revokeAccessBeforeCleanup');
  });

  it('the cleanup and the helpers it calls touch no users row', () => {
    const cleanup = bodyOf(account, 'const revokeAccessBeforeCleanup = async () => {', '\n      };\n');
    expect(awaited(cleanup)).toEqual(['tx.session.deleteMany', 'eraseUserDevices', 'tx.verificationDecisionOutbox.deleteMany', 'eraseOwedRowsInTransaction']);
    const owed = bodyOf(read('modules/user/erasure-coverage.ts'), 'export async function eraseOwedRowsInTransaction(', '\n}\n');
    expect(awaited(owed).filter((c) => !c.startsWith('tx.'))).toEqual(['bindTenantTransaction', 'eraseNoticesOf']);
    const binding = bodyOf(read('plugins/prisma.ts'), 'export async function bindTenantTransaction(', '\n}\n');
    const devices = bodyOf(read('lib/owner-rls.ts'), 'export async function eraseUserDevices(', '\n}\n');
    const notices = bodyOf(read('lib/owner-wall-notices.ts'), 'export async function eraseNoticesOf(', '\n}\n');
    for (const [name, body] of Object.entries({ cleanup, owed, binding, devices, notices })) {
      const code = stripComments(body);
      expect(code, name).not.toMatch(/\btx\s*\.\s*user\s*\./);
      expect(code, name).not.toMatch(/\busers\b/);
    }
    for (const [name, body] of Object.entries({ cleanup, owed })) expect(stripComments(body), name).not.toMatch(/\$(queryRaw|executeRaw)/);
    // The tenant binding's only SQL: set_config of the request's tenant (and person), nothing read.
    const statement = bodyOf(read('plugins/prisma.ts'), 'function bindingStatement<R>(', '\n}\n');
    const sql = [...stripComments(statement).matchAll(/\$executeRaw`([^`]*)`/g)].map((m) => m[1]!);
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) expect(s).toMatch(/^SELECT set_config\('app\.current_tenant', \$\{tenantId\}, true\)(, set_config\('app\.current_user', \$\{userId\}, true\))?$/);
    expect(stripComments(binding)).toContain('bindingStatement(tx, ctx.tenantId)');
    expect([...stripComments(binding).matchAll(/\$(queryRaw|executeRaw)`/g)]).toEqual([]);
    expect(stripComments(devices)).toContain('SELECT public.swift_owner_wall_erase_devices(${userId})');
    expect(stripComments(notices)).toContain('SELECT public.swift_owner_wall_erase_notices(${userId})');
  });

  it('on the cleanup\'s deletes only the off-site ledger\'s row capture fires (none on its money-command update), and users triggers ignore status, phone and avatar or need the complete tombstone', async () => {
    const deleted = ['sessions', 'device_tokens', 'verification_decision_outbox', 'notifications', 'money_surface_commands',
      'mover_revocation_outbox', 'guardian_checkin_deliveries', 'renewal_schedule', 'admins'];
    const fired = await owner.$queryRaw<Array<{ table: string; name: string; fn: string; tgtype: number }>>`
      SELECT c.relname::text AS "table", t.tgname::text AS name, p.proname::text AS fn, t.tgtype::int AS tgtype
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal
         AND ((c.relname = ANY(${deleted}::text[]) AND (t.tgtype & 8) <> 0)
           OR (c.relname = 'money_surface_commands' AND (t.tgtype & 16) <> 0))
       ORDER BY 1, 2`;
    // [#1984] The ONE trigger allowed here: the off-site erasure ledger's capture of a deleted row of a closed
    // account, AFTER DELETE FOR EACH ROW (tgtype 9: it cannot change the delete). It reads the tombstone phone, so
    // with the tombstone first the first pass now ledgers every row its cleanup removes ('deleted_rows'; the
    // behaviour is checked above). Nothing on money_surface_commands.
    const captured = deleted.filter((t) => t !== 'money_surface_commands');
    expect(fired).toEqual(captured.sort().map((table) => ({ table, name: 'erasure_ledger_deleted_row', fn: 'erasure_ledger_capture_closed_row', tgtype: 9 })));
    // That capture reads users only for the tombstone and writes only the append-only ledger (no INSERT trigger there).
    const [capture] = await owner.$queryRaw<Array<{ src: string }>>`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname = 'erasure_ledger_capture_closed_row'`;
    const src = capture!.src;
    expect(src.match(/\busers\b/g)).toEqual(['users']);
    expect(src).toContain('FROM users u WHERE u.id = owner AND u.phone = \'deleted:\' || u.id');
    expect([...src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)).toEqual(['INSERT INTO erasure_ledger_entry']);
    expect(src).toMatch(/RETURN NULL;\s*END\s*$/);
    const onLedger = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT t.tgname::text AS name FROM pg_trigger t
       WHERE t.tgrelid = 'public.erasure_ledger_entry'::regclass AND NOT t.tgisinternal AND (t.tgtype & 4) <> 0`;
    expect(onLedger).toEqual([]);
    const onUsers = await owner.$queryRaw<Array<{ name: string; columns: string[]; def: string; fn: string }>>`
      SELECT t.tgname::text AS name,
             ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k ORDER BY 1) AS columns,
             pg_get_triggerdef(t.oid) AS def, p.proname::text AS fn
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'public.users'::regclass AND NOT t.tgisinternal AND (t.tgtype & 16) <> 0
       ORDER BY 1`;
    expect(onUsers.length).toBeGreaterThan(0);
    // Each users UPDATE trigger names its columns or a WHEN on the tenant: none fires for the tombstone write.
    // [#1984] One more: the ledger's closed-account entry, whose WHEN needs the COMPLETE tombstone (name 'Deleted
    // User', no email, no password, no location), which the cut-off write (status, phone, avatar) does not make
    // unless the person's row already read so; even then it only appends an entry, and every row the cleanup
    // removes after it is ledgered as deleted (checked above with such a person).
    const completeTombstone = ['(new."firstName" = \'Deleted\'::text)', '(new."lastName" = \'User\'::text)', '(new.email IS NULL)',
      '(new."passwordHash" IS NULL)', '(new."lastKnownLat" IS NULL)', '(new."lastKnownLng" IS NULL)'];
    for (const t of onUsers) {
      const keyed = t.columns.length > 0 && !t.columns.some((c) => ['status', 'phone', 'avatar'].includes(c));
      const tenantOnly = /WHEN \(\(old\."tenantId" IS DISTINCT FROM new\."tenantId"\)\) EXECUTE/.test(t.def);
      const ledger = t.name === 'erasure_ledger_closed_accounts' && t.fn === 'erasure_ledger_capture_closed_account'
        && /^CREATE TRIGGER erasure_ledger_closed_accounts AFTER UPDATE ON public\.users FOR EACH ROW WHEN /.test(t.def)
        && completeTombstone.every((c) => t.def.includes(c));
      expect(keyed || tenantOnly || ledger, `${t.name}: ${t.def}`).toBe(true);
    }
    const [account] = await owner.$queryRaw<Array<{ src: string }>>`
      SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname = 'erasure_ledger_capture_closed_account'`;
    expect([...account!.src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)).toEqual(['INSERT INTO erasure_ledger_entry']);
  });

  it('both erase functions read users only for the guard: the tombstone of the person they erase', async () => {
    const rows = await owner.$queryRaw<Array<{ name: string; src: string; lang: string }>>`
      SELECT p.proname::text AS name, p.prosrc AS src, l.lanname::text AS lang
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public' JOIN pg_language l ON l.oid = p.prolang
       WHERE p.proname IN ('swift_owner_wall_erase_devices', 'swift_owner_wall_erase_notices') ORDER BY 1`;
    expect(rows.map((r) => r.name)).toEqual(['swift_owner_wall_erase_devices', 'swift_owner_wall_erase_notices']);
    for (const r of rows) {
      expect(r.src.match(/\busers\b/g), r.name).toEqual(['users']);
      expect(r.src, r.name).toContain('FROM public.users u WHERE u.id = p_user_id AND u.phone = \'deleted:\' || p_user_id');
      expect(r.src, r.name).toMatch(/RAISE EXCEPTION '[^']*not in erasure/);
    }
  });
});
