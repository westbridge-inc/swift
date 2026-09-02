import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * [INF-002] The developer bootstrap proves its target before the first SQL
 * statement, and never authors schema.
 *
 * `infrastructure/scripts/dev-setup.sh` used to run `prisma migrate dev` and a
 * confirmed demo seed after only ambient checks (is Docker up, is Postgres
 * ready). A copied `.env` or a mistaken `DATABASE_URL` would have applied
 * DEVELOPMENT migrations — generating new ones on drift — and seeded demo
 * accounts into whatever database the URL named: shared, staging, or
 * production-like. The seed guard (`assertSafeToSeedDemo`) protected only the
 * seed, and only after a connection had been made.
 *
 * Now the bootstrap is four separate stages — verify, create, migrate, seed —
 * and every mutating stage passes ALL of the following, in this order, or
 * refuses:
 *
 *   structural, before any connection:  SWIFT_DEV_BOOTSTRAP=YES · a loopback
 *     (or allowlisted) host · a disposable database name · an interactive
 *     terminal outside CI
 *   probed, read-only:  the connecting role is NOT the owner or a superuser
 *     (except `create`, the one owner stage) · the server-side marker stamped
 *     by `create` (a database comment: the database itself says it is
 *     disposable) · a schema fingerprint that is empty or a known prefix of the
 *     checked-in migration set — never "some tables from somewhere"
 *   then a typed confirmation naming the database.
 *
 * `migrate` applies the IMMUTABLE checked-in set with `prisma migrate deploy`
 * and nothing else: a failed migration in the history is refused (resolve it
 * by hand), a partial history resumes, and no stage can ever generate a
 * migration. `seed` runs the idempotent demo seed only against a fully
 * migrated database, then records the deployment identity the purge tool
 * (SCR-001) reads. Every stage appends an immutable journal line (never the
 * URL) and, once the tables exist, a privileged-change audit row.
 *
 * Rollback: unset SWIFT_DEV_BOOTSTRAP. Nothing here reverses a migration.
 */

export type Stage = 'verify' | 'create' | 'migrate' | 'seed';
export const STAGES: Stage[] = ['verify', 'create', 'migrate', 'seed'];
/** The database comment `create` stamps; `migrate` and `seed` require it. */
export const BOOTSTRAP_MARKER = 'swift:disposable-dev';
/** The least-privilege login `create` provisions and `migrate`/`seed` must use. Override with SWIFT_BOOTSTRAP_ROLE (the tests isolate themselves with it). */
export const BOOTSTRAP_ROLE = 'swift_bootstrap';
export const bootstrapRole = (env: Record<string, string | undefined>): string => env['SWIFT_BOOTSTRAP_ROLE'] ?? BOOTSTRAP_ROLE;
/** Database names a developer bootstrap may touch. Override with SWIFT_BOOTSTRAP_DB_ALLOWLIST (comma-separated). */
export const DEFAULT_DB_ALLOWLIST = ['swift', 'swift_test', 'swift_test2', 'swift_dev'];
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Extensions the migration set assumes and only a superuser may install: `create` installs them once, so the migration's IF NOT EXISTS is a no-op under the least-privilege role. */
export const OWNER_PREINSTALL_EXTENSIONS = ['postgis'];
/** Tables an installed extension owns in `public`; not user schema. */
const EXTENSION_TABLES = new Set(['spatial_ref_sys']);

export class BootstrapRefused extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); }
}

// ---------------------------------------------------------------------------
// The target — parsed, never echoed with its credentials
// ---------------------------------------------------------------------------

export interface Target { host: string; port: number; database: string; user: string; digest: string }

export function parseTarget(url: string): Target {
  let u: URL;
  try { u = new URL(url); } catch { throw new BootstrapRefused('BAD_URL', 'the database URL could not be parsed'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new BootstrapRefused('BAD_URL', `unsupported scheme ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : 5432;
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(u.username);
  if (!database) throw new BootstrapRefused('BAD_URL', 'the database URL names no database');
  const digest = createHash('sha256').update(`${host}:${port}/${database}`).digest('hex').slice(0, 16);
  return { host, port, database, user, digest };
}

// ---------------------------------------------------------------------------
// Structural proof — evaluated BEFORE any connection is opened
// ---------------------------------------------------------------------------

export interface Structural { target: Target; problems: string[] }

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function structuralProof(stage: Stage, url: string, env: Record<string, string | undefined>, io: { isTTY: boolean }): Structural {
  const target = parseTarget(url);
  const problems: string[] = [];
  if (env['SWIFT_DEV_BOOTSTRAP'] !== 'YES') problems.push('SWIFT_DEV_BOOTSTRAP=YES is required — the bootstrap is an explicit act');
  const hosts = list(env['SWIFT_BOOTSTRAP_HOST_ALLOWLIST']);
  if (!LOOPBACK_HOSTS.has(target.host) && !hosts.includes(target.host)) {
    problems.push(`host ${target.host} is not loopback and not in SWIFT_BOOTSTRAP_HOST_ALLOWLIST`);
  }
  const dbs = list(env['SWIFT_BOOTSTRAP_DB_ALLOWLIST']);
  const allowed = dbs.length ? dbs : DEFAULT_DB_ALLOWLIST;
  if (!allowed.includes(target.database)) problems.push(`database "${target.database}" is not a disposable development name (${allowed.join(', ')})`);
  // Reported for every stage; ENFORCED (before any connection) for the mutating ones — verify is read-only and may run anywhere.
  if (env['CI'] || env['GITHUB_ACTIONS']) problems.push('CI invocation — a mutating bootstrap stage is interactive, never a pipeline step');
  if (!io.isTTY) problems.push('no interactive terminal — the typed confirmation cannot be given');
  void stage;
  return { target, problems };
}

// ---------------------------------------------------------------------------
// Probed proof — read-only SQL against the target
// ---------------------------------------------------------------------------

export interface RawClient {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface AppliedMigration { name: string; finished: boolean; rolledBack: boolean }
export interface Probe {
  role: { name: string; superuser: boolean; owner: boolean };
  marker: string | null;
  tables: string[];
  applied: AppliedMigration[];
  hasAudit: boolean;
  hasIdentity: boolean;
}

export async function probeProof(client: RawClient): Promise<Probe> {
  const [role] = await client.query<{ name: string; superuser: boolean; owner: boolean }>(
    `SELECT current_user::text AS name,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            ((SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = current_user::text) AS owner`,
  );
  const [m] = await client.query<{ marker: string | null }>(
    `SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`,
  );
  const tables = (await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((r) => r.tablename);
  const [reg] = await client.query<{ migrations: string | null; audit: string | null; identity: string | null }>(
    `SELECT to_regclass('public._prisma_migrations')::text AS migrations, to_regclass('public.privileged_change_audit')::text AS audit, to_regclass('public.deployment_identity')::text AS identity`,
  );
  const applied = reg?.migrations
    ? (await client.query<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
        `SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY started_at ASC`,
      )).map((r) => ({ name: r.migration_name, finished: r.finished_at !== null, rolledBack: r.rolled_back_at !== null }))
    : [];
  return {
    role: { name: role?.name ?? '?', superuser: Boolean(role?.superuser), owner: Boolean(role?.owner) },
    marker: m?.marker ?? null,
    tables,
    applied,
    hasAudit: Boolean(reg?.audit),
    hasIdentity: Boolean(reg?.identity),
  };
}

// ---------------------------------------------------------------------------
// The schema fingerprint: empty, a known prefix of the checked-in set, complete — or refused
// ---------------------------------------------------------------------------

export type SchemaState = 'empty' | 'known' | 'complete' | 'failed' | 'unknown';
export interface Fingerprint { state: SchemaState; digest: string; applied: number; checkedIn: number; detail: string }

/** The immutable checked-in migration set, in order. */
export function checkedInMigrations(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_/.test(name) && statSync(join(migrationsDir, name)).isDirectory())
    .sort();
}

export function schemaFingerprint(probe: Pick<Probe, 'tables' | 'applied'>, checkedIn: string[]): Fingerprint {
  const userTables = probe.tables.filter((t) => t !== '_prisma_migrations' && !EXTENSION_TABLES.has(t));
  const live = probe.applied.filter((a) => !a.rolledBack);
  const failed = live.filter((a) => !a.finished);
  const names = live.filter((a) => a.finished).map((a) => a.name);
  const digest = createHash('sha256').update(names.join('\n')).digest('hex').slice(0, 16);
  const base = { digest, applied: names.length, checkedIn: checkedIn.length };
  if (failed.length) {
    return { ...base, state: 'failed', detail: `${failed.map((f) => f.name).join(', ')} started and never finished — resolve it by hand; the bootstrap never repairs or generates a migration` };
  }
  if (names.length === 0) {
    return userTables.length === 0
      ? { ...base, state: 'empty', detail: 'no tables, no migration history' }
      : { ...base, state: 'unknown', detail: `${userTables.length} table(s) exist with no migration history (${userTables.slice(0, 5).join(', ')}${userTables.length > 5 ? ', …' : ''})` };
  }
  for (let i = 0; i < names.length; i += 1) {
    if (names[i] !== checkedIn[i]) {
      return { ...base, state: 'unknown', detail: `applied history diverges from the checked-in set at #${i + 1}: ${names[i]} vs ${checkedIn[i] ?? '(none)'}` };
    }
  }
  if (names.length === checkedIn.length) return { ...base, state: 'complete', detail: `all ${names.length} checked-in migrations applied` };
  return { ...base, state: 'known', detail: `${names.length} of ${checkedIn.length} checked-in migrations applied; the rest resume` };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface Decision { allowed: boolean; code: string; reasons: string[] }

export function decide(stage: Stage, structural: Structural, probe: Probe, fp: Fingerprint, role = BOOTSTRAP_ROLE): Decision {
  if (stage === 'verify') return { allowed: true, code: 'REPORT', reasons: structural.problems };
  if (structural.problems.length) return { allowed: false, code: 'STRUCTURAL', reasons: structural.problems };
  const reasons: string[] = [];
  if (stage === 'create') {
    // The one owner stage: it stamps the marker and provisions the least-privilege login, on an EMPTY database only.
    if (!probe.role.owner && !probe.role.superuser) return { allowed: false, code: 'CREATE_NEEDS_OWNER', reasons: [`create needs the database owner or a superuser; ${probe.role.name} is neither`] };
    if (probe.marker === BOOTSTRAP_MARKER) return { allowed: true, code: 'ALREADY_MARKED', reasons: ['the database is already marked disposable; nothing to stamp'] };
    if (fp.state !== 'empty') return { allowed: false, code: 'UNKNOWN_DATABASE', reasons: [`the database is not empty (${fp.detail}) and carries no marker — a database with unknown contents is never declared disposable`] };
    return { allowed: true, code: 'STAMP', reasons: [] };
  }
  if (probe.role.superuser || probe.role.owner) reasons.push(`${probe.role.name} is ${probe.role.superuser ? 'a superuser' : 'the database owner'} — ${stage} runs only as the least-privilege ${role} login`);
  if (probe.marker !== BOOTSTRAP_MARKER) reasons.push(`the database carries no disposable marker (comment ${probe.marker === null ? 'absent' : JSON.stringify(probe.marker)}); run create first`);
  if (fp.state === 'failed' || fp.state === 'unknown') reasons.push(`schema ${fp.state}: ${fp.detail}`);
  if (stage === 'seed' && fp.state !== 'complete' && fp.state !== 'failed' && fp.state !== 'unknown') reasons.push(`seed needs a fully migrated database (${fp.detail}); run migrate first`);
  if (reasons.length) {
    const code = probe.role.superuser || probe.role.owner ? 'OWNER_ROLE' : probe.marker !== BOOTSTRAP_MARKER ? 'NO_MARKER' : fp.state === 'failed' ? 'FAILED_MIGRATION' : fp.state === 'unknown' ? 'UNKNOWN_SCHEMA' : 'NOT_MIGRATED';
    return { allowed: false, code, reasons };
  }
  if (stage === 'migrate') return fp.state === 'complete' ? { allowed: true, code: 'AT_HEAD', reasons: [fp.detail] } : { allowed: true, code: 'APPLY', reasons: [fp.detail] };
  return { allowed: true, code: 'SEED', reasons: [fp.detail] };
}

// ---------------------------------------------------------------------------
// The journal — append-only, never the URL
// ---------------------------------------------------------------------------

export interface JournalEntry {
  at: string;
  stage: Stage;
  event: 'refused' | 'decided' | 'confirmed' | 'ran' | 'completed' | 'failed';
  target: Target;
  role?: string;
  code?: string;
  reasons?: string[];
  fingerprint?: Fingerprint;
  dryRun?: boolean;
  detail?: string;
}

export function defaultJournalPath(env: Record<string, string | undefined> = process.env): string {
  return env['SWIFT_BOOTSTRAP_JOURNAL'] ?? join(env['HOME'] ?? '.', '.swift', 'bootstrap-journal.jsonl');
}

export function appendJournal(path: string, entry: JournalEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** A version for the demo dataset: the seed sources' digest, so the journal and the identity say WHICH dataset was applied. */
export function seedVersion(apiDir: string): string {
  const h = createHash('sha256');
  for (const f of ['prisma/seed.ts', 'prisma/seed-platform.ts']) {
    try { h.update(readFileSync(join(apiDir, f))); } catch { h.update(`missing:${f}`); }
  }
  return h.digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Running a stage
// ---------------------------------------------------------------------------

export interface Deps {
  env: Record<string, string | undefined>;
  /** The URL for THIS stage: the owner's for create, the bootstrap login's for migrate and seed. */
  url: string;
  isTTY: boolean;
  connect: (url: string) => Promise<RawClient>;
  /** Runs a Prisma command with the given extra environment. */
  exec: (args: string[], env: Record<string, string>) => Promise<void> | void;
  confirm: (question: string) => Promise<string>;
  checkedIn: string[];
  journal: (entry: JournalEntry) => void;
  /** The seed dataset version recorded on seed. */
  seedVersion?: string;
  dryRun?: boolean;
  now?: () => Date;
  /** `<stage>:<point>` — throws there, for the resume tests. */
  failpoint?: string;
}

export interface StageResult {
  stage: Stage;
  target: Target;
  decision: Decision;
  probe: Probe;
  fingerprint: Fingerprint;
  /** The Prisma commands this stage ran (or, in a dry run, would run). */
  commands: string[][];
  dryRun: boolean;
}

const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

function plannedCommands(stage: Stage, decision: Decision): string[][] {
  if (stage === 'migrate' && decision.code === 'APPLY') return [['prisma', 'migrate', 'deploy']];
  if (stage === 'seed') return [['prisma', 'db', 'seed']];
  return [];
}

export async function runStage(stage: Stage, deps: Deps): Promise<StageResult> {
  const now = deps.now ?? (() => new Date());
  const structural = structuralProof(stage, deps.url, deps.env, { isTTY: deps.isTTY });
  const target = structural.target;
  const entry = (e: Omit<JournalEntry, 'at' | 'stage' | 'target'>): JournalEntry => ({ at: now().toISOString(), stage, target, ...e });
  const hit = (point: string) => {
    if (deps.failpoint === `${stage}:${point}`) {
      deps.journal(entry({ event: 'failed', detail: `failpoint ${deps.failpoint}` }));
      throw new Error(`FAILPOINT ${deps.failpoint}`);
    }
  };
  // Structural refusals happen before ANY connection: a wrong host, a wrong
  // name or a pipeline never reaches the database.
  if (stage !== 'verify' && structural.problems.length) {
    deps.journal(entry({ event: 'refused', code: 'STRUCTURAL', reasons: structural.problems }));
    throw new BootstrapRefused('STRUCTURAL', structural.problems.join('; '));
  }
  const client = await deps.connect(deps.url);
  try {
    const probe = await probeProof(client);
    const fingerprint = schemaFingerprint(probe, deps.checkedIn);
    const role = bootstrapRole(deps.env);
    const decision = decide(stage, structural, probe, fingerprint, role);
    const dryRun = Boolean(deps.dryRun);
    deps.journal(entry({ event: decision.allowed ? 'decided' : 'refused', role: probe.role.name, code: decision.code, reasons: decision.reasons, fingerprint, dryRun }));
    if (!decision.allowed) throw new BootstrapRefused(decision.code, decision.reasons.join('; '));
    const commands = plannedCommands(stage, decision);
    const result: StageResult = { stage, target, decision, probe, fingerprint, commands, dryRun };
    if (stage === 'verify' || dryRun) return result;
    if (decision.code === 'ALREADY_MARKED' || decision.code === 'AT_HEAD') return result;

    // The typed confirmation names the database; anything else refuses.
    const phrase = `bootstrap ${target.database}`;
    const typed = (await deps.confirm(`Type "${phrase}" to run ${stage} on ${target.host}:${target.port}/${target.database} as ${probe.role.name}: `)).trim();
    if (typed !== phrase) {
      deps.journal(entry({ event: 'refused', code: 'NOT_CONFIRMED', reasons: ['the typed confirmation did not name the database'] }));
      throw new BootstrapRefused('NOT_CONFIRMED', `expected "${phrase}"`);
    }
    deps.journal(entry({ event: 'confirmed', role: probe.role.name, code: decision.code }));
    hit('before');

    if (stage === 'create') {
      const password = deps.env['SWIFT_BOOTSTRAP_PASSWORD'];
      if (!password || password.length < 16) throw new BootstrapRefused('NO_BOOTSTRAP_PASSWORD', `SWIFT_BOOTSTRAP_PASSWORD (16+ characters) is required to provision the ${role} login`);
      for (const ext of OWNER_PREINSTALL_EXTENSIONS) await client.exec(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(ext)}`);
      const [existing] = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${quoteLiteral(role)}`);
      // LOGIN, never SUPERUSER, never BYPASSRLS; CREATEROLE because two migrations create the RLS roles.
      // The password is whatever this run was given: an existing login is re-keyed, never left with an unknown one.
      if (!existing || existing.n === 0) await client.exec(`CREATE ROLE ${quoteIdent(role)} LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD ${quoteLiteral(password)}`);
      else await client.exec(`ALTER ROLE ${quoteIdent(role)} LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD ${quoteLiteral(password)}`);
      await client.exec(`GRANT CONNECT, CREATE ON DATABASE ${quoteIdent(target.database)} TO ${quoteIdent(role)}`);
      await client.exec(`GRANT CREATE, USAGE ON SCHEMA public TO ${quoteIdent(role)}`);
      hit('before-marker');
      await client.exec(`COMMENT ON DATABASE ${quoteIdent(target.database)} IS ${quoteLiteral(BOOTSTRAP_MARKER)}`);
      deps.journal(entry({ event: 'completed', role: probe.role.name, code: 'STAMP', detail: `marker stamped; ${role} provisioned; extensions ${OWNER_PREINSTALL_EXTENSIONS.join(', ')}` }));
      return result;
    }

    if (stage === 'migrate') {
      // The immutable checked-in set, and only that. Never `migrate dev`, never `db push`.
      await deps.exec(['prisma', 'migrate', 'deploy'], { DATABASE_URL: deps.url });
      deps.journal(entry({ event: 'ran', role: probe.role.name, detail: 'prisma migrate deploy' }));
      hit('after-deploy');
      const after = schemaFingerprint(await probeProof(client), deps.checkedIn);
      if (after.state !== 'complete') {
        deps.journal(entry({ event: 'failed', code: 'INCOMPLETE', fingerprint: after, detail: after.detail }));
        throw new BootstrapRefused('INCOMPLETE', `after deploy the schema is ${after.state}: ${after.detail}`);
      }
      await audit(client, 'BOOTSTRAP_MIGRATE', target, { from: fingerprint.digest, to: after.digest, applied: after.applied }, probe.role.name);
      deps.journal(entry({ event: 'completed', role: probe.role.name, code: 'APPLY', fingerprint: after }));
      return { ...result, fingerprint: after };
    }

    // seed
    const version = deps.seedVersion ?? 'unversioned';
    await deps.exec(['prisma', 'db', 'seed'], { DATABASE_URL: deps.url, NODE_ENV: 'development', SEED_DEMO_CONFIRM: 'YES', SEED_VERSION: version });
    deps.journal(entry({ event: 'ran', role: probe.role.name, detail: `prisma db seed (dataset ${version})` }));
    hit('after-seed');
    if (probe.hasIdentity) {
      // The identity the purge tool (SCR-001) and every operator report read: this database is a development deployment.
      await client.exec(
        `INSERT INTO public.deployment_identity ("id", "deploymentId", "environment", "note", "createdAt", "updatedAt")
         VALUES ('singleton', ${quoteLiteral(`local-${target.digest}`)}, 'development', ${quoteLiteral(`bootstrap seed ${version}`)}, now(), now())
         ON CONFLICT ("id") DO UPDATE SET "deploymentId" = EXCLUDED."deploymentId", "environment" = 'development', "note" = EXCLUDED."note", "updatedAt" = now()`,
      );
    }
    await audit(client, 'BOOTSTRAP_SEED', target, { dataset: version }, probe.role.name);
    deps.journal(entry({ event: 'completed', role: probe.role.name, code: 'SEED', detail: `dataset ${version}${probe.hasIdentity ? '; deployment identity recorded' : '; deployment_identity table absent — identity not recorded'}` }));
    return result;
  } finally {
    await client.close();
  }
}

/** One privileged-change audit row (SCR-001's append-only table) when it exists; the journal is the record otherwise. */
async function audit(client: RawClient, action: string, target: Target, detail: Record<string, unknown>, actor: string): Promise<void> {
  const [reg] = await client.query<{ audit: string | null }>(`SELECT to_regclass('public.privileged_change_audit')::text AS audit`);
  if (!reg?.audit) return;
  const id = `bs_${randomBytes(12).toString('hex')}`;
  await client.exec(
    `INSERT INTO public.privileged_change_audit ("id", "action", "planDigest", "event", "target", "detail", "actor", "createdAt")
     VALUES (${quoteLiteral(id)}, ${quoteLiteral(action)}, ${quoteLiteral(target.digest)}, 'completed', ${quoteLiteral(JSON.stringify({ host: target.host, port: target.port, database: target.database }))}::jsonb, ${quoteLiteral(JSON.stringify(detail))}::jsonb, ${quoteLiteral(actor)}, now())`,
  );
}

// ---------------------------------------------------------------------------
// No client is constructed here. Production source never calls Prisma's
// unsafe raw APIs (the SQL-safety census refuses it); the ONE executor that
// runs these statements lives with the dev bootstrap script and the test,
// each behind the RawClient seam above.
// ---------------------------------------------------------------------------
