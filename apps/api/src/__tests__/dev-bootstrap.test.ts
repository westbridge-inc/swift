import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { PrismaClient } from '@prisma/client';

import {
  BOOTSTRAP_MARKER, BootstrapRefused, appendJournal, bootstrapRole, checkedInMigrations, parseTarget, runStage, schemaFingerprint, structuralProof,
  type Deps, type JournalEntry, type Stage, type RawClient } from '../modules/ops/bootstrap-plan';
/** The test's raw executor — the same six lines as apps/api/scripts/dev/bootstrap-raw-client.ts
 *  (a test cannot import from scripts/ under rootDir, and production source may not hold it). */
async function prismaRawClient(url: string): Promise<RawClient> {
  const prisma = new PrismaClient({ datasources: { db: { url } }, log: [] });
  await prisma.$connect();
  return {
    query: <T = Record<string, unknown>>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql),
    exec: async (sql: string) => { await prisma.$executeRawUnsafe(sql); },
    close: () => prisma.$disconnect(),
  };
}



// ---------------------------------------------------------------------------
// [INF-002] The developer bootstrap proves its target before the first SQL
// statement and never authors schema.
//
// The register's red proof: a wrong hostname, a wrong database name, an
// owner role, a nonempty unknown schema, an absent marker and a CI or
// non-interactive invocation all fail — the structural ones before any
// connection is opened. A failpoint between stages leaves a state the next run
// resumes from, and no run ever generates a migration: the only command a
// stage runs is `prisma migrate deploy` (or `db seed`), against the immutable
// checked-in set. The proof is driven against a real scratch database on the
// test server, as a real least-privilege login the `create` stage provisions.
// ---------------------------------------------------------------------------

const OWNER_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ownerTarget = parseTarget(OWNER_URL);
const ownerBase = new URL(OWNER_URL);
const withDb = (db: string, user?: string, password?: string): string => {
  const u = new URL(OWNER_URL);
  u.pathname = `/${db}`;
  if (user !== undefined) { u.username = user; u.password = password ?? ''; }
  return u.toString();
};
const suffix = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const DB = `swift_test_bs_${suffix}`;
const ROLE = `swift_bs_${suffix}`;
const PASSWORD = `probe-password-${nanoid(12)}`;
const MAINT_URL = withDb('postgres');
const SCRATCH_OWNER_URL = withDb(DB);
const SCRATCH_LOGIN_URL = withDb(DB, ROLE, PASSWORD);
const CHECKED = checkedInMigrations(join(process.cwd(), 'prisma', 'migrations'));

let tmp: string;
let journalPath: string;
let maint: RawClient;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Prisma's own migration-history table, so a fake deploy leaves exactly what a real one leaves. */
async function fakeDeploy(url: string, names: string[], withTables: boolean): Promise<void> {
  const c = await prismaRawClient(url);
  try {
    await c.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" varchar(36) PRIMARY KEY, "checksum" varchar(64) NOT NULL, "finished_at" timestamptz, "migration_name" varchar(255) NOT NULL,
      "logs" text, "rolled_back_at" timestamptz, "started_at" timestamptz NOT NULL DEFAULT now(), "applied_steps_count" integer NOT NULL DEFAULT 0)`);
    for (const name of names) {
      await c.exec(`INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
        VALUES (${q(nanoid(36).slice(0, 36))}, ${q('0'.repeat(64))}, clock_timestamp(), ${q(name)}, clock_timestamp(), 1)`);
    }
    if (withTables) {
      // The two tables the seed stage writes (SCR-001's), exactly as their migration creates them.
      await c.exec(`CREATE TABLE IF NOT EXISTS "deployment_identity" ("id" TEXT NOT NULL DEFAULT 'singleton', "deploymentId" TEXT NOT NULL, "environment" TEXT NOT NULL, "note" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "deployment_identity_pkey" PRIMARY KEY ("id"))`);
      await c.exec(`CREATE TABLE IF NOT EXISTS "privileged_change_audit" ("id" TEXT NOT NULL, "action" TEXT NOT NULL, "planDigest" TEXT NOT NULL, "event" TEXT NOT NULL, "target" JSONB NOT NULL,
        "detail" JSONB, "actor" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "privileged_change_audit_pkey" PRIMARY KEY ("id"))`);
    }
  } finally { await c.close(); }
}

interface Harness { deps: Deps; connects: string[]; execs: Array<{ args: string[]; env: Record<string, string> }>; confirms: number }
function harness(url: string, over: Partial<Deps> & { env?: Record<string, string | undefined> } = {}): Harness {
  const connects: string[] = [];
  const execs: Array<{ args: string[]; env: Record<string, string> }> = [];
  const h: Harness = { connects, execs, confirms: 0, deps: {} as Deps };
  h.deps = {
    env: { HOME: tmp, SWIFT_DEV_BOOTSTRAP: 'YES', SWIFT_BOOTSTRAP_DB_ALLOWLIST: DB, SWIFT_BOOTSTRAP_ROLE: ROLE, SWIFT_BOOTSTRAP_PASSWORD: PASSWORD, ...(over.env ?? {}) },
    url,
    isTTY: over.isTTY ?? true,
    connect: async (u) => { connects.push(u); return prismaRawClient(u); },
    exec: over.exec ?? (async (args, env) => { execs.push({ args, env }); }),
    confirm: over.confirm ?? (async () => { h.confirms += 1; return `bootstrap ${DB}`; }),
    checkedIn: CHECKED,
    journal: (e: JournalEntry) => appendJournal(journalPath, e),
    seedVersion: 'v-test',
    dryRun: over.dryRun,
    failpoint: over.failpoint,
  };
  return h;
}
const journal = (): JournalEntry[] => readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
const refused = async (p: Promise<unknown>): Promise<BootstrapRefused> => {
  try { await p; } catch (e) { if (e instanceof BootstrapRefused) return e; throw e; }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'swift-bootstrap-'));
  journalPath = join(tmp, 'journal.jsonl');
  maint = await prismaRawClient(MAINT_URL);
  await maint.exec(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  await maint.exec(`CREATE DATABASE "${DB}"`);
});
afterAll(async () => {
  await maint.exec(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
  await maint.exec(`DROP ROLE IF EXISTS "${ROLE}"`).catch(() => {});
  await maint.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('[INF-002] the target is proven before the first SQL statement', () => {
  const MUTATING: Stage[] = ['create', 'migrate', 'seed'];
  it('a wrong hostname, a wrong database name, an unset switch, CI and no terminal each refuse every mutating stage with ZERO connections and ZERO commands', async () => {
    const cases: Array<{ name: string; url?: string; env?: Record<string, string | undefined>; isTTY?: boolean; expect: string }> = [
      { name: 'wrong host', url: `postgresql://${ROLE}:x@db.internal.example:5432/${DB}`, expect: 'not loopback' },
      { name: 'wrong database', url: withDb('swift_prod', ROLE, PASSWORD), expect: 'not a disposable development name' },
      { name: 'switch unset', env: { SWIFT_DEV_BOOTSTRAP: undefined }, expect: 'SWIFT_DEV_BOOTSTRAP=YES' },
      { name: 'CI', env: { CI: '1' }, expect: 'CI invocation' },
      { name: 'GitHub Actions', env: { GITHUB_ACTIONS: 'true' }, expect: 'CI invocation' },
      { name: 'no terminal', isTTY: false, expect: 'no interactive terminal' },
    ];
    for (const c of cases) {
      for (const stage of MUTATING) {
        const h = harness(c.url ?? SCRATCH_LOGIN_URL, { env: c.env, isTTY: c.isTTY });
        const err = await refused(runStage(stage, h.deps));
        expect(err.code, `${c.name} / ${stage}`).toBe('STRUCTURAL');
        expect(err.message, `${c.name} / ${stage}`).toContain(c.expect);
        expect(h.connects, `${c.name} / ${stage} connected`).toHaveLength(0);
        expect(h.execs, `${c.name} / ${stage} ran`).toHaveLength(0);
        expect(h.confirms, `${c.name} / ${stage} asked`).toBe(0);
      }
    }
    const entries = journal().filter((e) => e.event === 'refused' && e.code === 'STRUCTURAL');
    expect(entries.length).toBe(cases.length * MUTATING.length);
  });

  it('verify is read-only and allowed anywhere (CI included): it connects, probes, reports every problem and runs nothing', async () => {
    const h = harness(SCRATCH_OWNER_URL, { env: { CI: '1' } });
    const r = await runStage('verify', h.deps);
    expect(r.decision.code).toBe('REPORT');
    expect(r.decision.reasons.join(' ')).toContain('CI invocation');
    expect(r.probe.marker).toBeNull();
    expect(r.fingerprint.state).toBe('empty');
    expect(r.probe.role.superuser || r.probe.role.owner).toBe(true);
    expect(h.connects).toHaveLength(1);
    expect(h.execs).toHaveLength(0);
    expect(h.confirms).toBe(0);
  });

  it('an owner or superuser cannot migrate or seed, and a nonempty database with no history is never stamped or migrated', async () => {
    const asOwner = await refused(runStage('migrate', harness(SCRATCH_OWNER_URL).deps));
    expect(asOwner.code).toBe('OWNER_ROLE');
    expect(asOwner.message).toContain(`only as the least-privilege ${ROLE} login`);
    // a stray table and no migration history: unknown contents
    const owner = await prismaRawClient(SCRATCH_OWNER_URL);
    await owner.exec(`CREATE TABLE "stray" ("id" int)`);
    try {
      const create = await refused(runStage('create', harness(SCRATCH_OWNER_URL).deps));
      expect(create.code).toBe('UNKNOWN_DATABASE');
      expect(create.message).toContain('never declared disposable');
      const [m] = await owner.query<{ marker: string | null }>(`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`);
      expect(m?.marker ?? null).toBeNull();
    } finally {
      await owner.exec(`DROP TABLE "stray"`);
      await owner.close();
    }
  });

  it('create (the one owner stage) refuses a confirmation that does not name the database, then stamps the marker, installs the extension and provisions the least-privilege login; a second create is a no-op', async () => {
    const wrong = harness(SCRATCH_OWNER_URL, { confirm: async () => 'yes' });
    const err = await refused(runStage('create', wrong.deps));
    expect(err.code).toBe('NOT_CONFIRMED');
    let probe = await runStage('verify', harness(SCRATCH_OWNER_URL).deps);
    expect(probe.probe.marker).toBeNull();

    const h = harness(SCRATCH_OWNER_URL);
    const r = await runStage('create', h.deps);
    expect(r.decision.code).toBe('STAMP');
    expect(h.confirms).toBe(1);
    expect(h.execs).toHaveLength(0); // create runs SQL as the owner; it never runs a Prisma command
    probe = await runStage('verify', harness(SCRATCH_OWNER_URL).deps);
    expect(probe.probe.marker).toBe(BOOTSTRAP_MARKER);
    const [role] = await maint.query<{ rolsuper: boolean; rolcanlogin: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = ${q(ROLE)}`);
    expect(role).toMatchObject({ rolsuper: false, rolcanlogin: true, rolbypassrls: false });
    const scratch = await prismaRawClient(SCRATCH_OWNER_URL);
    try {
      // extensions are per database: the owner stage installed it HERE, where the least-privilege migrate needs it
      const [ext] = await scratch.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'postgis'`);
      expect(ext?.n).toBe(1);
    } finally { await scratch.close(); }

    const again = harness(SCRATCH_OWNER_URL);
    const r2 = await runStage('create', again.deps);
    expect(r2.decision.code).toBe('ALREADY_MARKED');
    expect(again.confirms).toBe(0);
  });

  it('migrate and seed require the server-side marker and a known schema: the same login is refused before any command when the comment is gone or a stray table exists', async () => {
    const owner = await prismaRawClient(SCRATCH_OWNER_URL);
    try {
      await owner.exec(`COMMENT ON DATABASE "${DB}" IS NULL`);
      for (const stage of ['migrate', 'seed'] as Stage[]) {
        const h = harness(SCRATCH_LOGIN_URL);
        const err = await refused(runStage(stage, h.deps));
        expect(err.code, stage).toBe('NO_MARKER');
        expect(err.message).toContain('run create first');
        expect(h.execs).toHaveLength(0);
        expect(h.confirms).toBe(0);
      }
      await owner.exec(`COMMENT ON DATABASE "${DB}" IS '${BOOTSTRAP_MARKER}'`);
      await owner.exec(`CREATE TABLE "stray" ("id" int)`);
      const h = harness(SCRATCH_LOGIN_URL);
      const err = await refused(runStage('migrate', h.deps));
      expect(err.code).toBe('UNKNOWN_SCHEMA');
      expect(err.message).toContain('no migration history');
      expect(h.execs).toHaveLength(0);
    } finally {
      await owner.exec(`DROP TABLE IF EXISTS "stray"`);
      await owner.exec(`COMMENT ON DATABASE "${DB}" IS '${BOOTSTRAP_MARKER}'`);
      await owner.close();
    }
  });

  it('the provisioned login passes the role gate; a dry run proves and plans the exact command and runs nothing', async () => {
    const h = harness(SCRATCH_LOGIN_URL, { dryRun: true });
    const r = await runStage('migrate', h.deps);
    expect(r.probe.role).toMatchObject({ name: ROLE, superuser: false, owner: false });
    expect(r.decision.code).toBe('APPLY');
    expect(r.fingerprint.state).toBe('empty');
    expect(r.commands).toEqual([['prisma', 'migrate', 'deploy']]);
    expect(h.execs).toHaveLength(0);
    expect(h.confirms).toBe(0);
    expect(journal().at(-1)).toMatchObject({ stage: 'migrate', event: 'decided', code: 'APPLY', dryRun: true, role: ROLE });
  });

  it('seed refuses a database that is not fully migrated', async () => {
    const h = harness(SCRATCH_LOGIN_URL);
    const err = await refused(runStage('seed', h.deps));
    expect(err.code).toBe('NOT_MIGRATED');
    expect(h.execs).toHaveLength(0);
  });

  it('migrate as the login runs exactly `prisma migrate deploy`; a failpoint after deploy leaves a KNOWN history the next run resumes; nothing ever generates; at head it is a no-op', async () => {
    const half = Math.floor(CHECKED.length / 2);
    // 1. an interrupted deploy: half the set lands, then the process dies
    const first = harness(SCRATCH_LOGIN_URL, {
      exec: async (args, env) => { first.execs.push({ args, env }); await fakeDeploy(env['DATABASE_URL']!, CHECKED.slice(0, half), false); },
      failpoint: 'migrate:after-deploy',
    });
    await expect(runStage('migrate', first.deps)).rejects.toThrow(/FAILPOINT migrate:after-deploy/);
    expect(first.execs).toHaveLength(1);
    expect(journal().at(-1)).toMatchObject({ stage: 'migrate', event: 'failed' });

    // 2. the next run finds a known prefix and resumes with the same immutable command
    const second = harness(SCRATCH_LOGIN_URL, {
      exec: async (args, env) => { second.execs.push({ args, env }); await fakeDeploy(env['DATABASE_URL']!, CHECKED.slice(half), true); },
    });
    const r = await runStage('migrate', second.deps);
    expect(r.decision.code).toBe('APPLY');
    expect(r.decision.reasons[0]).toContain(`${half} of ${CHECKED.length}`);
    expect(r.fingerprint.state).toBe('complete');
    expect(second.execs).toHaveLength(1);
    for (const e of [...first.execs, ...second.execs]) {
      expect(e.args).toEqual(['prisma', 'migrate', 'deploy']);
      expect(e.env['DATABASE_URL']).toBe(SCRATCH_LOGIN_URL);
      expect(e.args.join(' ')).not.toMatch(/dev|push|reset/);
    }
    const login = await prismaRawClient(SCRATCH_LOGIN_URL);
    try {
      const [a] = await login.query<{ n: number }>(`SELECT count(*)::int AS n FROM "privileged_change_audit" WHERE action = 'BOOTSTRAP_MIGRATE'`);
      expect(a?.n).toBe(1);
    } finally { await login.close(); }

    // 3. at head: nothing to run, nothing asked
    const third = harness(SCRATCH_LOGIN_URL);
    const r3 = await runStage('migrate', third.deps);
    expect(r3.decision.code).toBe('AT_HEAD');
    expect(third.execs).toHaveLength(0);
    expect(third.confirms).toBe(0);
  });

  it('seed runs only as the login on the migrated database, hands the seed guard its own confirmation, and records the deployment identity and an audit row', async () => {
    const h = harness(SCRATCH_LOGIN_URL);
    const r = await runStage('seed', h.deps);
    expect(r.decision.code).toBe('SEED');
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0]!.args).toEqual(['prisma', 'db', 'seed']);
    expect(h.execs[0]!.env).toMatchObject({ DATABASE_URL: SCRATCH_LOGIN_URL, NODE_ENV: 'development', SEED_DEMO_CONFIRM: 'YES', SEED_VERSION: 'v-test' });
    const login = await prismaRawClient(SCRATCH_LOGIN_URL);
    try {
      const [id] = await login.query<{ deploymentId: string; environment: string; note: string }>(`SELECT "deploymentId", "environment", "note" FROM "deployment_identity" WHERE id = 'singleton'`);
      expect(id).toMatchObject({ environment: 'development', note: 'bootstrap seed v-test' });
      expect(id?.deploymentId).toBe(`local-${parseTarget(SCRATCH_LOGIN_URL).digest}`);
      const [a] = await login.query<{ n: number }>(`SELECT count(*)::int AS n FROM "privileged_change_audit" WHERE action = 'BOOTSTRAP_SEED'`);
      expect(a?.n).toBe(1);
    } finally { await login.close(); }
    // the owner still cannot seed, marker or not
    const owner = await refused(runStage('seed', harness(SCRATCH_OWNER_URL).deps));
    expect(owner.code).toBe('OWNER_ROLE');
  });

  it('a migration that started and never finished refuses migrate — the bootstrap never repairs or generates', async () => {
    const owner = await prismaRawClient(SCRATCH_OWNER_URL);
    await owner.exec(`INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at") VALUES ('failed-row', '${'0'.repeat(64)}', '99999999999999_never_finished', clock_timestamp())`);
    try {
      const h = harness(SCRATCH_LOGIN_URL);
      const err = await refused(runStage('migrate', h.deps));
      expect(err.code).toBe('FAILED_MIGRATION');
      expect(err.message).toContain('resolve it by hand');
      expect(h.execs).toHaveLength(0);
    } finally {
      await owner.exec(`DELETE FROM "_prisma_migrations" WHERE id = 'failed-row'`);
      await owner.close();
    }
  });

  it('the journal is the immutable record and never carries a connection string or a password', () => {
    const text = readFileSync(journalPath, 'utf8');
    expect(text).not.toContain('postgresql://');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(`${ownerBase.username}:${ownerBase.password}@`);
    expect(text).not.toContain(`${ROLE}:`);
    const entries = journal();
    // every entry names its target structurally (host, port, database, digest) and nothing else
    expect(entries.every((e) => typeof e.target.host === 'string' && typeof e.target.digest === 'string' && Object.keys(e.target).sort().join(',') === 'database,digest,host,port,user')).toBe(true);
    expect(entries.some((e) => e.target.host === ownerTarget.host)).toBe(true);
    expect(entries.map((e) => e.event)).toEqual(expect.arrayContaining(['refused', 'decided', 'confirmed', 'ran', 'completed', 'failed']));
  });
});

describe('[INF-002] the fingerprint and the structural proof, as pure functions', () => {
  const applied = (names: string[]) => names.map((name) => ({ name, finished: true, rolledBack: false }));
  it('empty, known prefix, complete, diverged, tables-without-history, failed, rolled-back-ignored', () => {
    const set = ['20260101000000_a', '20260102000000_b', '20260103000000_c'];
    expect(schemaFingerprint({ tables: [], applied: [] }, set).state).toBe('empty');
    expect(schemaFingerprint({ tables: ['spatial_ref_sys'], applied: [] }, set).state).toBe('empty');
    expect(schemaFingerprint({ tables: ['users'], applied: [] }, set).state).toBe('unknown');
    expect(schemaFingerprint({ tables: ['_prisma_migrations'], applied: applied(set.slice(0, 2)) }, set)).toMatchObject({ state: 'known', applied: 2, checkedIn: 3 });
    expect(schemaFingerprint({ tables: [], applied: applied(set) }, set).state).toBe('complete');
    expect(schemaFingerprint({ tables: [], applied: applied(['20260101000000_a', '20260102000000_zz']) }, set)).toMatchObject({ state: 'unknown' });
    expect(schemaFingerprint({ tables: [], applied: [...applied(set.slice(0, 1)), { name: set[1]!, finished: false, rolledBack: false }] }, set).state).toBe('failed');
    expect(schemaFingerprint({ tables: [], applied: [...applied(set), { name: 'x', finished: false, rolledBack: true }] }, set).state).toBe('complete');
  });
  it('the allowlists are explicit: a non-loopback host needs SWIFT_BOOTSTRAP_HOST_ALLOWLIST, a database name needs the default or configured list, verify never needs a terminal', () => {
    const env = { SWIFT_DEV_BOOTSTRAP: 'YES' };
    expect(structuralProof('migrate', 'postgresql://u:p@localhost:5434/swift', env, { isTTY: true }).problems).toEqual([]);
    expect(structuralProof('migrate', 'postgresql://u:p@10.0.0.9:5432/swift', env, { isTTY: true }).problems.join(' ')).toContain('not loopback');
    expect(structuralProof('migrate', 'postgresql://u:p@10.0.0.9:5432/swift', { ...env, SWIFT_BOOTSTRAP_HOST_ALLOWLIST: '10.0.0.9' }, { isTTY: true }).problems).toEqual([]);
    expect(structuralProof('migrate', 'postgresql://u:p@localhost/swift_production', env, { isTTY: true }).problems.join(' ')).toContain('not a disposable');
    expect(structuralProof('migrate', 'postgresql://u:p@localhost/swift_scratch', { ...env, SWIFT_BOOTSTRAP_DB_ALLOWLIST: 'swift_scratch' }, { isTTY: true }).problems).toEqual([]);
    // verify REPORTS the interactive problems (it is allowed anyway); a mutating stage is refused on them before any connection
    expect(structuralProof('verify', 'postgresql://u:p@localhost/swift', { ...env, CI: '1' }, { isTTY: false }).problems).toHaveLength(2);
    expect(structuralProof('seed', 'postgresql://u:p@localhost/swift', { ...env, CI: '1' }, { isTTY: false }).problems).toHaveLength(2);
    expect(bootstrapRole({})).toBe('swift_bootstrap');
    expect(bootstrapRole({ SWIFT_BOOTSTRAP_ROLE: 'x_login' })).toBe('x_login');
  });
});
