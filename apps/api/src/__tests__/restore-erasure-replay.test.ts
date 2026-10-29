import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { AccountService } from '../modules/user/account.service';

// ---------------------------------------------------------------------------
// [item 196] A RESTORED COPY BRINGS NO ERASED PERSON BACK, on real databases.
//
// A "live" database with the real Swift schema (a schema-only copy of the test
// database) gets two people. It is dumped with the real pg_dump. Then one of
// them closes their account through the canonical path (AccountService) in the
// live database: their document key is destroyed, the document retired, the
// extracted values shredded, the account row de-identified, sessions and saved
// addresses removed, a deletion receipt written. The real deploy/restore.sh
// restores the OLDER dump into a scratch database with the real pg_restore.
// The restored copy must show the erasure, quarantined from application logins,
// and the other person untouched. Only `docker compose exec postgres` (the LIVE
// side) is a stand-in: it runs the same command on this host against the test
// server. [SEC-BACKUP F2] The copy itself is restored for real into restore.sh's
// throwaway instance (a container of the Postgres image, no network) as a login
// that is not a superuser there, from a dump signed like backup.sh signs it.
// Every name and value is synthetic.
// ---------------------------------------------------------------------------

const DEPLOY = join(process.cwd(), '../../deploy');
const PGURL = new URL(process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test');
const TEST_DB = PGURL.pathname.replace(/^\//, '');
const PG = { port: PGURL.port || '5432', user: decodeURIComponent(PGURL.username), password: decodeURIComponent(PGURL.password) };
const pgEnv = () => ({ PATH: process.env['PATH'] ?? '', PGHOST: '127.0.0.1', PGPORT: PG.port, PGUSER: PG.user, PGPASSWORD: PG.password });
const psql = (db: string, sql: string): string =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-qtA', '-d', db, '-c', sql], { env: pgEnv(), encoding: 'utf8' }).trim();
const urlFor = (db: string) => { const u = new URL(PGURL.toString()); u.pathname = `/${db}`; return u.toString(); };

/** Sessions store digests of their tokens (64 hex), never the tokens. */
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const ID = Math.random().toString(36).slice(2, 10);
const LIVE = `swift_test_rlive_${ID}`;
let tmp = '';
const created: string[] = [];
// [SEC-BACKUP F2] The real docker CLI (the stand-in on PATH forwards everything but the live side to it).
const REAL_DOCKER = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
const PG_IMAGE = 'postgis/postgis:16-3.4';
const instances: string[] = [];
const instanceOf = (scratch: string) => `swift-restore-${scratch}`;
/** A query on the scratch copy, inside its throwaway instance (as the instance's own superuser, to inspect it). */
const inCopy = (scratch: string, sql: string): string =>
  execFileSync(REAL_DOCKER, ['exec', instanceOf(scratch), 'psql', '-X', '-h', '/var/run/postgresql', '-U', 'swift_restore_admin', '-d', scratch, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], { encoding: 'utf8' }).trim();
const instanceExists = (scratch: string) => spawnSync(REAL_DOCKER, ['container', 'inspect', instanceOf(scratch)], { stdio: 'ignore' }).status === 0;
/** Signed exactly as backup.sh signs a dump: <dump>.sig beside it, verified against ALLOWED. */
const sign = (file: string) => execFileSync('python3', ['-I', join(DEPLOY, 'backup-signature.py'), 'sign', '--key', join(tmp, 'signing'), '--object', file, '--out', `${file}.sig`, '--created', '20261028T000000Z']);
/** [BACKUP-FU] An off-site ledger directory as the owner leaves it after decrypting: the batch's
 *  plain .jsonl beside the .jsonl.gpg.sig the shipper uploaded, signed exactly as
 *  erasure-ledger-ship.sh signs it (over the encrypted copy, binding the plain batch's SHA-256). */
function ledgerDir(lines: string, opts: { signed?: boolean; tamper?: boolean } = {}) {
  const dir = mkdtempSync(join(tmp, 'offsite-ledger-'));
  const base = 'erasure-ledger-20261028T100000Z-0b9f0c3e';
  const plain = join(dir, `${base}.jsonl`);
  writeFileSync(plain, lines + '\n', { mode: 0o600 });
  if (opts.signed ?? true) {
    const encrypted = join(dir, `${base}.jsonl.gpg`);
    writeFileSync(encrypted, 'synthetic ciphertext');
    execFileSync('python3', ['-I', join(DEPLOY, 'backup-signature.py'), 'sign', '--key', join(tmp, 'signing'), '--object', encrypted,
      '--out', `${encrypted}.sig`, '--plain-sha256', createHash('sha256').update(readFileSync(plain)).digest('hex'), '--created', '20261028T100000Z',
      // [BACKUP-FU · COORD] the first (and only) batch of the chain
      '--prev', 'none']);
    rmSync(encrypted);
  }
  if (opts.tamper) writeFileSync(plain, readFileSync(plain, 'utf8').replace(/"closed_accounts"/, '"deleted_rows"'), { mode: 0o600 });
  chmodSync(dir, 0o700);
  return dir;
}
let live: PrismaClient;
const people = { kept: '', closed: '', doc: '', key: '', run: '', field: '' };

function shim(name: string, body: string) {
  const path = join(tmp, 'bin', name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** The real restore.sh (with its two ledger files) against LIVE, into a new scratch database. */
function restore(dump: string, opts: { args?: string[]; replaySuffix?: string } = {}) {
  const scratch = `swift_test_rscr_${ID}_${Math.random().toString(36).slice(2, 6)}`;
  created.push(scratch);
  const here = join(tmp, `deploy-${scratch}`);
  mkdirSync(here, { recursive: true });
  for (const f of ['restore.sh', 'restore-erasure-ledger.sql', 'restore-offsite-ledger.sql', 'secret-env.sh', 'backup-signature.py']) copyFileSync(join(DEPLOY, f), join(here, f));
  writeFileSync(join(here, 'restore-replay-erasures.sql'), readFileSync(join(DEPLOY, 'restore-replay-erasures.sql'), 'utf8') + (opts.replaySuffix ?? ''));
  writeFileSync(join(here, '.env'), `POSTGRES_DB=${LIVE}\n`);
  instances.push(instanceOf(scratch));
  const res = spawnSync('bash', [join(here, 'restore.sh'), '--project', 'swift-test-restore', ...(opts.args ?? []), dump, scratch], {
    encoding: 'utf8', timeout: 240_000,
    env: { PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, CALL_LOG: join(tmp, 'calls'), PG_USER: PG.user, PG_PASSFILE: join(tmp, 'pgpass'), PG_PORT: PG.port,
      REAL_DOCKER, PG_IMAGE, POSTGRES_USER: PG.user, BACKUP_SIGNING_ALLOWED_SIGNERS: join(tmp, 'allowed_signers') },
  });
  return { ...res, scratch };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'swift-restore-erasure-'));
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(join(tmp, 'pgpass'), PG.password);
  writeFileSync(join(tmp, 'calls'), '');
  // The LIVE side (`docker compose ... exec -T postgres <cmd>`) runs <cmd> here against the test
  // server; `compose ps` finds no live container, so `compose config` names the image; every
  // other docker call (the throwaway instance) is the real docker.
  shim('docker', [
    'echo "docker $*" >> "$CALL_LOG"',
    'if [ "$1" != compose ]; then exec "$REAL_DOCKER" "$@"; fi',
    'for a in "$@"; do case "$a" in exec) break ;; ps) exit 0 ;; config) printf \'{"services":{"postgres":{"image":"%s"}}}\\n\' "$PG_IMAGE"; exit 0 ;; esac; done',
    'while [ $# -gt 0 ] && [ "$1" != postgres ]; do shift; done',
    '[ $# -gt 0 ] || exit 0',
    'shift',
    'export POSTGRES_USER="$PG_USER" POSTGRES_PASSWORD_FILE="$PG_PASSFILE" PGPORT="$PG_PORT"',
    'exec "$@"',
  ].join('\n'));
  // [SEC-BACKUP F2] A backup signing key of the test's own, and the allowed-signers file restores trust.
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'swift-backup-signing', '-f', join(tmp, 'signing')]);
  const pub = readFileSync(join(tmp, 'signing.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  writeFileSync(join(tmp, 'allowed_signers'), `swift-backup namespaces="swift-backup" ${pub}\n`, { mode: 0o644 });
  // The live database: the test database's schema (tables, RLS, triggers,
  // functions), none of its rows.
  created.push(LIVE);
  psql('postgres', `CREATE DATABASE ${LIVE}`);
  // (custom format + pg_restore, which speaks the server's version; a plain
  // dump from a newer client can carry settings an older server refuses)
  const schema = join(tmp, 'schema.dump');
  execFileSync('pg_dump', ['-Fc', '--schema-only', '--no-owner', '-d', TEST_DB, '-f', schema], { env: pgEnv() });
  execFileSync('pg_restore', ['--exit-on-error', '--no-owner', '-d', LIVE, schema], { env: pgEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  // Reference rows the migrations write and the canonical path reads (the
  // document state machine's legal transitions).
  const reference = join(tmp, 'reference.dump');
  execFileSync('pg_dump', ['-Fc', '--data-only', '-t', 'doc_state_transition', '-d', TEST_DB, '-f', reference], { env: pgEnv() });
  execFileSync('pg_restore', ['--exit-on-error', '--no-owner', '--disable-triggers', '-d', LIVE, reference], { env: pgEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
  live = testPrismaClient(urlFor(LIVE));
  await live.tenant.create({ data: { id: 'swift-default', name: 'Swift', slug: 'swift' } });
  await live.$executeRawUnsafe(`INSERT INTO country_configs (id, code, name, "currencyCode", "usdExchangeRate", "subscriptionTiers", "documentChecklists", "updatedAt") VALUES ('cc-${ID}', 'GY', 'Guyana', 'GYD', 209, '[]', '{}', now())`);
  const mk = (phone: string, firstName: string) => live.user.create({ data: { phone, firstName, lastName: 'Fixture', activeRole: 'CUSTOMER', roles: ['CUSTOMER'], email: `${firstName.toLowerCase()}.${ID}@example.invalid`, passwordHash: 'synthetic-hash' } });
  const kept = await mk('+15550000001', 'Keeper');
  const closed = await mk('+15550000002', 'Closer');
  people.kept = kept.id; people.closed = closed.id;
  for (const u of [kept, closed]) {
    await live.session.create({ data: { userId: u.id, token: digest(`t-${u.id}`), refreshToken: digest(`r-${u.id}`), deviceId: 'd', deviceType: 'ios', expiresAt: new Date(Date.now() + 86_400_000) } });
    await live.address.create({ data: { userId: u.id, label: 'Home', addressLine1: 'Synthetic 1', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15 } });
  }
  // The closed person's identity document: an encrypted object with its key,
  // the document pointing at it, and one extracted value.
  people.key = `verification/${closed.id}/doc-${ID}.enc`;
  await live.encryptedObject.create({ data: { fileKey: people.key, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.from('synthetic-wrapped-key'), mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64), createdBy: closed.id } });
  const doc = await live.verificationDocument.create({ data: { userId: closed.id, role: 'CUSTOMER', docType: 'national_id', fileUrl: people.key } });
  people.doc = doc.id;
  const run = await live.extractionRun.create({ data: { submissionId: doc.id, profileCode: 'p', engineName: 'synthetic', engineVersion: '1', startedAt: new Date(), outcome: 'OK', wrappedDek: Buffer.from('synthetic-run-key') } });
  const field = await live.extractedField.create({ data: { runId: run.id, submissionId: doc.id, fieldCode: 'name', source: 'OCR_VLM', valueCt: Buffer.from('synthetic-value') } });
  people.run = run.id; people.field = field.id;
}, 180_000);

afterAll(async () => {
  await live?.$disconnect().catch(() => {});
  for (const name of instances.splice(0)) {
    spawnSync(REAL_DOCKER, ['rm', '-f', name], { stdio: 'ignore' });
    spawnSync(REAL_DOCKER, ['volume', 'rm', name], { stdio: 'ignore' });
  }
  for (const db of created.splice(0)) {
    try { psql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch { /* best effort */ }
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}, 120_000);

const dump = (name: string) => {
  const file = join(tmp, `${name}.dump`);
  execFileSync('pg_dump', ['-Fc', '-d', LIVE, '-f', file], { env: pgEnv() });
  sign(file);
  return file;
};
/** The live database on the test server; a scratch copy inside its throwaway instance. */
const one = (db: string, sql: string) => (db === LIVE || db === TEST_DB || db === 'postgres' ? psql(db, sql) : inCopy(db, sql));
/** Logins other than the restore login and the instance's superuser that can open the copy. */
const loginRolesThatCanConnect = (db: string) =>
  inCopy(db, `SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname NOT IN (current_user, '${PG.user}') AND has_database_privilege(rolname, '${db}', 'CONNECT')`);
/** The copy's database ACL inside its instance: PUBLIC holds nothing. */
const copyAcl = (db: string) => inCopy(db, `SELECT coalesce(datacl::text, '') FROM pg_database WHERE datname = '${db}'`);

describe('[item 196] a restore replays the live erasure ledger before it reports', { timeout: 300_000 }, () => {
  let before = '';
  let after = '';

  it('an account closed after the backup is closed in the restored copy; the other person is untouched; the copy is quarantined', async () => {
    before = dump('before');
    const app = { prisma: live, log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, io: { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } } };
    await new AccountService(app as never).deleteAccount(people.closed);
    // The canonical path did its work in the live database.
    expect(one(LIVE, `SELECT phone FROM users WHERE id = '${people.closed}'`)).toBe(`deleted:${people.closed}`);
    expect(one(LIVE, `SELECT "wrappedDek" IS NULL FROM encrypted_objects WHERE "fileKey" = '${people.key}'`)).toBe('t');
    expect(Number(one(LIVE, `SELECT count(*) FROM deletion_receipt WHERE "subjectId" = '${people.closed}'`))).toBe(1);

    // (kept on purpose to look inside it; by default the copy goes with its instance: proven below)
    const r = restore(before, { args: ['--keep-for-inspection'] });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('RESTORE OK');
    expect(r.stdout).toMatch(/erasure ledger replayed: 1 destroyed keys, 1 receipts, 1 retired documents, 1 closed accounts in the live ledger; changed in this copy: .*1 closed accounts/);
    const s = r.scratch;
    // The person is gone from the copy, as from the live database.
    expect(one(s, `SELECT phone || '|' || "firstName" || '|' || coalesce(email, '-') || '|' || coalesce("passwordHash", '-') || '|' || status FROM users WHERE id = '${people.closed}'`))
      .toBe(`deleted:${people.closed}|Deleted|-|-|DEACTIVATED`);
    expect(one(s, `SELECT count(*) FROM sessions WHERE "userId" = '${people.closed}'`)).toBe('0');
    expect(one(s, `SELECT count(*) FROM addresses WHERE "userId" = '${people.closed}'`)).toBe('0');
    expect(one(s, `SELECT "wrappedDek" IS NULL AND "shreddedAt" IS NOT NULL FROM encrypted_objects WHERE "fileKey" = '${people.key}'`)).toBe('t');
    expect(one(s, `SELECT "fileUrl" = '' AND "purgedAt" IS NOT NULL FROM verification_documents WHERE id = '${people.doc}'`)).toBe('t');
    expect(one(s, `SELECT "wrappedDek" IS NULL FROM extraction_run WHERE id = '${people.run}'`)).toBe('t');
    expect(one(s, `SELECT "valueCt" IS NULL FROM extracted_field WHERE id = '${people.field}'`)).toBe('t');
    expect(one(s, `SELECT count(*) FROM deletion_receipt WHERE "subjectId" = '${people.closed}'`)).toBe('1');
    // Nothing else moved: the other person is whole.
    expect(one(s, `SELECT phone || '|' || "firstName" FROM users WHERE id = '${people.kept}'`)).toBe('+15550000001|Keeper');
    expect(one(s, `SELECT count(*) FROM sessions WHERE "userId" = '${people.kept}'`)).toBe('1');
    expect(one(s, `SELECT count(*) FROM addresses WHERE "userId" = '${people.kept}'`)).toBe('1');
    // Quarantined: no application login can connect to the copy.
    expect(loginRolesThatCanConnect(s)).toBe('0');
    expect(copyAcl(s)).not.toMatch(/(^|[{,])=/);
    expect(r.stdout).toContain('no application login can');
    // [SEC-BACKUP F2] Never in the live cluster, and restored by a login that is not a superuser.
    expect(one('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${s}'`)).toBe('0');
    expect(inCopy(s, `SELECT rolsuper FROM pg_roles WHERE rolname = '${PG.user}'`)).toBe('f');
    expect(inCopy(s, `SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = 'users'`)).toBe(PG.user);
    expect(r.stdout).toContain(`scratch instance : ${instanceOf(s)} (throwaway, no network`);
  });

  it('a fresh dump: the replay changes nothing, so --compare-source still proves the copy equal to its source', () => {
    after = dump('after');
    const r = restore(after, { args: ['--compare-source'] });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('changed in this copy: nothing (the copy already matched)');
    expect(r.stdout).toContain('the scratch restore equals its source');
    expect(r.stdout).toContain('RESTORE OK');
    // [SEC-BACKUP · REVIEW-M S3-1] not kept: the copy is gone with its instance and volume
    expect(instanceExists(r.scratch)).toBe(false);
    expect(spawnSync(REAL_DOCKER, ['volume', 'inspect', instanceOf(r.scratch)], { stdio: 'ignore' }).status).not.toBe(0);
  });

  it('a replay that fails reports no restore and DROPS the copy (erased people must not sit in it); --keep-failed keeps it quarantined and unchanged', () => {
    const dropped = restore(before, { replaySuffix: '\nSELECT 1 / 0;\n' });
    expect(dropped.status).not.toBe(0);
    expect(dropped.stderr).toContain('erasure ledger replay failed');
    expect(dropped.stderr).toContain('was dropped');
    expect(dropped.stdout).not.toContain('RESTORE OK');
    expect(instanceExists(dropped.scratch)).toBe(false);
    const kept = restore(before, { args: ['--keep-failed'], replaySuffix: '\nSELECT 1 / 0;\n' });
    expect(kept.status).not.toBe(0);
    expect(kept.stdout).not.toContain('RESTORE OK');
    // One transaction: nothing was half-applied, and nobody but the operator can open the copy.
    expect(one(kept.scratch, `SELECT phone FROM users WHERE id = '${people.closed}'`)).toBe('+15550000002');
    expect(loginRolesThatCanConnect(kept.scratch)).toBe('0');
  });

  it('the disaster-recovery mode (no live ledger) restores the copy quarantined and never calls it restored', () => {
    const r = restore(before, { args: ['--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection'] });
    expect(r.status, r.stderr + r.stdout).toBe(3);
    expect(r.stdout + r.stderr).toContain('NOT erasure-complete: replay the off-site ledger before use');
    expect(r.stdout + r.stderr).not.toContain('RESTORE OK');
    // The backup's state, not erasure-complete: the person closed after the backup is still whole here.
    expect(one(r.scratch, `SELECT phone FROM users WHERE id = '${people.closed}'`)).toBe('+15550000002');
    expect(loginRolesThatCanConnect(r.scratch)).toBe('0');
    expect(copyAcl(r.scratch)).not.toMatch(/(^|[{,])=/);
  });

  it('[off-site ledger] with the live database gone, the shipped erasure ledger makes the copy erasure-complete up to its newest entry', () => {
    // What the host unit ships: every entry the closure wrote in the live database, one JSON object per line.
    const lines = psql(LIVE, `SELECT json_build_object('id', e.id, 'kind', e.kind, 'entry', e.entry,
      'createdAt', to_char(e."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'))::text FROM erasure_ledger_entry e ORDER BY e."createdAt", e.id`);
    expect(lines).toContain('"closed_accounts"');
    // [BACKUP-FU] the batch as shipped: signed, and verified before anything is created
    const dir = ledgerDir(lines);
    const newest = psql(LIVE, `SELECT to_char(max("createdAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS') FROM erasure_ledger_entry`);
    const r = restore(before, { args: ['--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection', '--ledger-from', dir] });
    expect(r.status, r.stderr + r.stdout).toBe(3);
    expect(r.stderr).toContain('signature OK: erasure-ledger-20261028T100000Z-0b9f0c3e.jsonl.gpg was signed by the trusted backup signing key');
    expect(r.stdout).toContain('off-site ledger : 1 signed batch(es) verified');
    expect(r.stdout).toContain('the signed batches form one unbroken chain');
    expect(r.stdout + r.stderr).toContain(`erasure-complete up to ${newest}`);
    expect(r.stdout + r.stderr).not.toContain('RESTORE OK');
    const s = r.scratch;
    expect(one(s, `SELECT phone || '|' || "firstName" || '|' || coalesce(email, '-') || '|' || coalesce("passwordHash", '-') || '|' || status FROM users WHERE id = '${people.closed}'`))
      .toBe(`deleted:${people.closed}|Deleted|-|-|DEACTIVATED`);
    expect(one(s, `SELECT count(*) FROM sessions WHERE "userId" = '${people.closed}'`)).toBe('0');
    expect(one(s, `SELECT count(*) FROM addresses WHERE "userId" = '${people.closed}'`)).toBe('0');
    expect(one(s, `SELECT "wrappedDek" IS NULL FROM encrypted_objects WHERE "fileKey" = '${people.key}'`)).toBe('t');
    expect(one(s, `SELECT "fileUrl" = '' AND "purgedAt" IS NOT NULL FROM verification_documents WHERE id = '${people.doc}'`)).toBe('t');
    expect(one(s, `SELECT "valueCt" IS NULL FROM extracted_field WHERE id = '${people.field}'`)).toBe('t');
    expect(one(s, `SELECT count(*) FROM deletion_receipt WHERE "subjectId" = '${people.closed}'`)).toBe('1');
    expect(one(s, `SELECT phone || '|' || "firstName" FROM users WHERE id = '${people.kept}'`)).toBe('+15550000001|Keeper');
    expect(one(s, `SELECT count(*) FROM sessions WHERE "userId" = '${people.kept}'`)).toBe('1');
    expect(loginRolesThatCanConnect(s)).toBe('0');
  });

  it('[BACKUP-FU] an off-site batch that is unsigned, or changed after it was signed, is refused before any instance exists', () => {
    const lines = psql(LIVE, `SELECT json_build_object('id', e.id, 'kind', e.kind, 'entry', e.entry,
      'createdAt', to_char(e."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'))::text FROM erasure_ledger_entry e ORDER BY e."createdAt", e.id`);
    for (const [opts, says] of [[{ signed: false }, 'has NO signature'], [{ tamper: true }, 'was REFUSED']] as const) {
      const r = restore(before, { args: ['--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection', '--ledger-from', ledgerDir(lines, opts)] });
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stderr).toContain(says);
      expect(r.stdout).not.toContain('scratch instance');
      expect(instanceExists(r.scratch)).toBe(false);
    }
  });

  it('every ledger entry reads tables and columns that exist in the Swift schema', () => {
    const ledger = readFileSync(join(DEPLOY, 'restore-erasure-ledger.sql'), 'utf8');
    const entries = [...ledger.matchAll(/^-- ledger: ([a-z_]+)\n(SELECT .+)$/gm)].map((m) => ({ name: m[1]!, select: m[2]! }));
    expect(entries.map((e) => e.name)).toEqual(['destroyed_keys', 'readable_receipt_keys', 'receipts', 'retired_documents', 'shredded_runs', 'shredded_fields', 'closed_accounts', 'closed_account_rows', 'erased_rating_text', 'erased_outbox_text']);
    for (const e of entries) expect(() => psql(TEST_DB, `SELECT count(*) FROM (${e.select}) x`), e.name).not.toThrow();
  });
});
