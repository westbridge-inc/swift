/**
 * appRoleDdl() heals a test database's application role with a broad
 * `GRANT ... ON ALL TABLES IN SCHEMA public TO swift_app`. Some migrations
 * narrow that role afterwards with `REVOKE ... FROM swift_app`: settled billing
 * facts the app may add to but never change or remove, provider payment
 * aliases it may only look up, the operator-only purge functions. A heal that
 * does not re-apply those revocations hands the privileges back, and every
 * suite that runs after it in the same database sees an app role that may
 * UPDATE or DELETE rows production refuses. Whether a suite that proves the
 * refusal then passes depends on file order (13 Oct: a new suite that healed
 * the role sorted just ahead of billing-obligation-resume and turned it red).
 *
 * Two checks keep the heal equal to what the migrations leave behind:
 *  1. census: every `REVOKE ... FROM swift_app` in prisma/migrations is
 *     re-applied by appRoleDdl() after its broad grant, with at least the same
 *     privileges, and the heal revokes no table the migrations do not;
 *  2. database: after the heal runs, swift_app holds none of the privileges
 *     the migrations revoked, and an app-role write to a settled billing
 *     transition is refused.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { appRoleDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';

grantSuiteCapability('ddl');

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
const REVOKE = /\bREVOKE\s+([A-Za-z ,]+?)\s+ON\s+(?:(TABLE|FUNCTION)\s+)?([\s\S]+?)\s+FROM\s+([^;]+);/gi;

interface Revocation {
  source: string;
  kind: 'TABLE' | 'FUNCTION';
  /** schema-qualified, unquoted, lower case (functions: name only) */
  object: string;
  privileges: string[];
}

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const qualify = (name: string) => {
  const bare = name.trim().replace(/"/g, '').toLowerCase();
  return bare.includes('.') ? bare : `public.${bare}`;
};
const privilegesOf = (list: string) => {
  const words = list.toUpperCase().split(/[\s,]+/).filter(Boolean).filter((w) => w !== 'PRIVILEGES');
  return words.includes('ALL') ? [...TABLE_PRIVILEGES] : words;
};

/** Every REVOKE in `sql` whose grantee list names swift_app, one row per object. */
function revocationsIn(sql: string, source: string): { rows: Revocation[]; statements: number } {
  const rows: Revocation[] = [];
  let statements = 0;
  for (const m of stripComments(sql).matchAll(REVOKE)) {
    const grantees = m[4]!.split(',').map((g) => g.trim().replace(/"/g, '').toLowerCase());
    if (!grantees.includes('swift_app')) continue;
    statements += 1;
    if (m[2]?.toUpperCase() === 'FUNCTION') {
      const name = /([A-Za-z0-9_."]+)\s*\(/.exec(m[3]!)?.[1] ?? m[3]!;
      rows.push({ source, kind: 'FUNCTION', object: name.replace(/"/g, '').split('.').pop()!.toLowerCase(), privileges: privilegesOf(m[1]!) });
      continue;
    }
    for (const table of m[3]!.split(',')) rows.push({ source, kind: 'TABLE', object: qualify(table), privileges: privilegesOf(m[1]!) });
  }
  return { rows, statements };
}

function migrationRevocations() {
  const statements: Revocation[] = [];
  let parsed = 0;
  let crude = 0;
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    const file = join(MIGRATIONS, dir, 'migration.sql');
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, 'utf8');
    const found = revocationsIn(sql, dir);
    statements.push(...found.rows);
    parsed += found.statements;
    // An independent count of REVOKE statements naming swift_app, so a parser
    // that silently skips a statement cannot pass the census.
    crude += (stripComments(sql).match(/\bREVOKE\b[^;]*\bFROM\b[^;]*\bswift_app\b[^;]*;/gi) ?? []).length;
  }
  return { statements, parsed, crude };
}

/** Table revocations appRoleDdl() applies after its broad table grant. */
function healRevocations() {
  const ddl = appRoleDdl();
  const grant = ddl.findIndex((s) => /GRANT\s+SELECT,\s*INSERT,\s*UPDATE,\s*DELETE\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+TO\s+swift_app/i.test(s));
  expect(grant, 'appRoleDdl() still heals with a broad table grant').toBeGreaterThanOrEqual(0);
  return {
    afterGrant: ddl.slice(grant + 1).flatMap((s, i) => revocationsIn(s, `appRoleDdl()[${grant + 1 + i}]`).rows),
    beforeGrant: ddl.slice(0, grant).flatMap((s) => revocationsIn(s, 'before').rows).filter((r) => r.kind === 'TABLE'),
    text: ddl.join('\n'),
  };
}

describe('appRoleDdl() re-applies every migration revocation from swift_app', () => {
  it('the census parses every REVOKE ... FROM swift_app in the migrations', () => {
    const { statements, parsed, crude } = migrationRevocations();
    expect(crude).toBeGreaterThan(0);
    expect(parsed).toBe(crude);
    expect(statements.some((r) => r.kind === 'TABLE' && r.object === 'public.billing_obligation_transitions')).toBe(true);
  });

  it('every table revocation is mirrored after the broad grant, with at least the same privileges', () => {
    const { statements } = migrationRevocations();
    const { afterGrant } = healRevocations();
    const missing = statements
      .filter((r) => r.kind === 'TABLE')
      .flatMap((r) => r.privileges
        .filter((p) => !afterGrant.some((h) => h.kind === 'TABLE' && h.object === r.object && h.privileges.includes(p)))
        .map((p) => `${r.source}: ${p} ON ${r.object}`));
    expect(missing).toEqual([]);
  });

  it('every function revocation is mirrored by the heal', () => {
    const { statements } = migrationRevocations();
    const { text } = healRevocations();
    const fnStatement = appRoleDdl().find((s) => /REVOKE\s+ALL\s+ON\s+FUNCTION/i.test(s)) ?? '';
    const missing = statements
      .filter((r) => r.kind === 'FUNCTION')
      .filter((r) => !fnStatement.includes(`'${r.object}'`))
      .map((r) => `${r.source}: ${r.object}`);
    expect(text).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION/i);
    expect(missing).toEqual([]);
  });

  it('the heal revokes no table privilege the migrations do not, and nothing before its grant', () => {
    const { statements } = migrationRevocations();
    const { afterGrant, beforeGrant } = healRevocations();
    const extra = afterGrant
      .filter((h) => h.kind === 'TABLE')
      .flatMap((h) => h.privileges
        .filter((p) => !statements.some((r) => r.kind === 'TABLE' && r.object === h.object && r.privileges.includes(p)))
        .map((p) => `${p} ON ${h.object}`));
    expect(extra).toEqual([]);
    expect(beforeGrant).toEqual([]);
  });
});

describe('after the heal runs, swift_app holds none of the revoked privileges', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it('has_table_privilege is false for every migration-revoked table privilege', async () => {
    await installDdl(prisma, appRoleDdl());
    const { statements } = migrationRevocations();
    const tables = statements.filter((r) => r.kind === 'TABLE');
    expect(tables.length).toBeGreaterThan(0);
    const held: string[] = [];
    let checked = 0;
    for (const r of tables) {
      const [{ present }] = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${r.object}) IS NOT NULL AS present`;
      if (!present) continue; // a db-push database has no raw-SQL-only tables
      for (const p of r.privileges) {
        const [{ allowed }] = await prisma.$queryRaw<Array<{ allowed: boolean }>>`SELECT has_table_privilege('swift_app', ${r.object}, ${p}) AS allowed`;
        checked += 1;
        if (allowed) held.push(`${p} ON ${r.object}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(held).toEqual([]);
  });

  it('the app role cannot change or remove a settled billing obligation transition after the heal', async () => {
    await installDdl(prisma, appRoleDdl());
    for (const write of [
      'UPDATE billing_obligation_transitions SET amount = amount WHERE false',
      'DELETE FROM billing_obligation_transitions WHERE false',
    ]) {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE swift_app');
        await tx.$executeRawUnsafe(write);
      })).rejects.toThrow(/permission denied/i);
    }
  });
});
