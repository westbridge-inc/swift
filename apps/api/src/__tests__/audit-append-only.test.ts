import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { appRoleDdl } from '../lib/tenant-rls';
import { AUDIT_PURGE_SETTING, purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [ADM-003] THE RECORD OF A PRIVILEGED ACTION CANNOT BE EDITED AFTERWARDS.
//
// Appendix AJ measured the admin authority surface as one boolean, and behind
// it: ban a user, process a settlement, waive a fee, set national pricing,
// broadcast to everyone. The record of all of it lived in `audit_logs` — a
// table with no trigger, no rule and no constraint, in a schema that already
// makes EvidenceBundle immutable at the database. Anyone able to reach the
// database, the application role included, could alter or remove the record of
// what they had just done. An audit trail the actor can edit is not evidence.
//
// The database now refuses. UPDATE has no exception: a correction is a new
// row. DELETE has exactly one — a transaction that names itself a retention
// purge — and the census at the bottom keeps that exception inside the one
// helper, so it cannot spread into the application by copy.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const RUN = nanoid(8);
const ids: string[] = [];
const readIds: string[] = [];
let probeRole = '';
let roleCreated = false;

async function seed(action = 'ADM003_SEED'): Promise<string> {
  const row = await prisma.auditLog.create({
    data: { action, entity: `AuditProbe${RUN}`, entityId: `probe-${nanoid(6)}`, changes: { before: 1 } },
  });
  ids.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await prisma.$connect();
  const [row] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database()::text AS db`;
  if (!row || !/^swift_test[a-z0-9_]*$/.test(row.db)) throw new Error('test namespace required');
  probeRole = `${row.db.slice(0, 35)}_audit_${RUN.toLowerCase()}`;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${probeRole}" NOLOGIN`);
  roleCreated = true;
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${probeRole}"`);
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs, sensitive_read_logs TO "${probeRole}"`);
});
afterAll(async () => {
  await purgeAuditLogs(prisma, { entity: `AuditProbe${RUN}` }, 'test-cleanup:audit-append-only');
  await purgeSensitiveReadLogs(prisma, { id: { in: readIds } }, 'test-cleanup:audit-purge-authority');
  if (roleCreated) {
    await prisma.$executeRawUnsafe(`REVOKE SELECT, INSERT, UPDATE, DELETE ON audit_logs, sensitive_read_logs FROM "${probeRole}"`);
    await prisma.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM "${probeRole}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE "${probeRole}"`);
  }
  await prisma.$disconnect();
});

describe('[ADM-003] the database refuses to change an audit row', () => {
  it('an UPDATE is refused — through the ORM and through raw SQL alike', async () => {
    const id = await seed();
    await expect(prisma.auditLog.update({ where: { id }, data: { action: 'EDITED' } }))
      .rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'EDITED' WHERE id = ${id}`)
      .rejects.toThrow(/append-only/);
    // and the row is untouched
    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(after.action).toBe('ADM003_SEED');
  });

  it('changing the CONTENT of the record is refused too — not just its action name', async () => {
    const id = await seed();
    await expect(prisma.$executeRaw`UPDATE audit_logs SET changes = '{"before":999}'::jsonb WHERE id = ${id}`)
      .rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE audit_logs SET "userId" = 'someone-else' WHERE id = ${id}`)
      .rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`UPDATE audit_logs SET "createdAt" = now() - interval '10 years' WHERE id = ${id}`)
      .rejects.toThrow(/append-only/);
    const after = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(after.changes).toEqual({ before: 1 });
    expect(after.userId).toBeNull();
  });

  it('a DELETE is refused — a stray deleteMany anywhere in the application now fails', async () => {
    const id = await seed();
    await expect(prisma.auditLog.delete({ where: { id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({ where: { id } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${id}`).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
  });

  it('a caller-selected purge setting does not license deletion', async () => {
    const id = await seed();
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, 'caller-selected-reason', true)`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE id = ${id}`;
    })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
  });

  it('TRUNCATE is refused — a row trigger does not fire for it, so it has its own', async () => {
    await seed();
    // Other retained evidence now references audit rows (mover fee decisions,
    // consumed weekly-fee obligations), so a bare TRUNCATE is refused by those
    // foreign keys before the trigger is reached. It stays refused.
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow();
    // CASCADE clears the foreign keys to reach the trigger itself, inside a
    // transaction that is always rolled back: a missing trigger truncates nothing.
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('TRUNCATE audit_logs CASCADE');
      throw new Error('TRUNCATE was not refused');
    })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { entity: `AuditProbe${RUN}` } })).toBeGreaterThan(0);
  });

  it('a failed edit does not take the rest of the work with it — the refusal is the statement, not the connection', async () => {
    const id = await seed();
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'EDITED' WHERE id = ${id}`).rejects.toThrow();
    // the next write still lands: the trigger refuses a statement, and callers
    // that (rightly) never try do not pay for the ones that do
    const next = await seed('ADM003_AFTER_REFUSAL');
    expect(await prisma.auditLog.count({ where: { id: next } })).toBe(1);
  });
});

describe('[ADM-003] the one exception requires dedicated database authority', () => {
  it('a privileged purge requires a stated reason and grants no authority to the next direct delete', async () => {
    const id = await seed('ADM003_PURGEABLE');
    const removed = await purgeAuditLogs(prisma, { id }, 'retention:adm003-suite');
    expect(removed).toBe(1);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(0);

    // Function authority does not license a direct delete afterwards.
    const other = await seed();
    await expect(prisma.auditLog.deleteMany({ where: { id: other } })).rejects.toThrow(/append-only/);
  });

  it('a purge with no reason, or a token one, is refused before it reaches the database', async () => {
    const id = await seed();
    await expect(purgeAuditLogs(prisma, { id }, '')).rejects.toThrow(/must name its reason/);
    await expect(purgeAuditLogs(prisma, { id }, 'x')).rejects.toThrow(/must name its reason/);
    await expect(purgeAuditLogs(prisma, { id }, '        ')).rejects.toThrow(/must name its reason/);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
  });

  it('a session that merely sets the setting OUTSIDE a transaction does not get a standing licence', async () => {
    const id = await seed();
    // Neither a caller-selected local setting nor the next direct statement
    // obtains the dedicated function owner's authority.
    await prisma.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, 'not-a-batch', true)`;
    await expect(prisma.auditLog.deleteMany({ where: { id } })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
  });
});

describe('dedicated audit purge authority', () => {
  it('swift_app cannot execute either purge function before or after the app-role installer', async () => {
    for (const reinstall of [false, true]) {
      if (reinstall) {
        for (const ddl of appRoleDdl()) await prisma.$executeRawUnsafe(ddl);
      }
      const privileges = await prisma.$queryRaw<Array<{ name: string; allowed: boolean }>>`
        SELECT p.proname AS name, has_function_privilege('swift_app', p.oid, 'EXECUTE') AS allowed
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('swift_purge_audit_logs', 'swift_purge_sensitive_read_logs')`;
      expect(privileges).toHaveLength(2);
      expect(privileges.map(row => row.allowed)).toEqual([false, false]);
    }
  });

  it('swift_app cannot delete either trail through SQL, settings, purge functions, truncation or role assumption', async () => {
    const id = await seed();
    const read = await prisma.sensitiveReadLog.create({ data: {
      actorUserId: `probe-${RUN}`, action: 'AUDIT_APP_PROBE', capability: 'test', purpose: 'test fixture',
    } });
    readIds.push(read.id);
    for (const [table, rowId, fn] of [
      ['audit_logs', id, 'swift_purge_audit_logs'],
      ['sensitive_read_logs', read.id, 'swift_purge_sensitive_read_logs'],
    ]) {
      for (const statement of [
        `DELETE FROM public.${table} WHERE id = '${rowId}'`,
        `UPDATE public.${table} SET id = id WHERE id = '${rowId}'`,
        `ALTER TABLE public.${table} DISABLE TRIGGER ALL`,
        'SET LOCAL session_replication_role = replica',
        `SELECT public.${fn}(ARRAY['${rowId}']::text[], 'test-cleanup:app-refused')`,
        `TRUNCATE public.${table}`,
        'SET LOCAL ROLE swift_audit_purge_owner',
        'SET LOCAL ROLE swift_audit_purge_executor',
      ]) {
        await expect(prisma.$transaction(async tx => {
          await tx.$executeRawUnsafe('SET LOCAL SESSION AUTHORIZATION swift_app');
          await tx.$executeRaw`SELECT set_config('app.current_tenant', 'swift-default', true)`;
          await tx.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, 'test-cleanup:app-setting', true)`;
          await tx.$executeRawUnsafe(statement);
        })).rejects.toThrow(/append-only|permission denied|must be owner of table/);
      }
    }
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
    expect(await prisma.sensitiveReadLog.count({ where: { id: read.id } })).toBe(1);
  });

  it('an ordinary role cannot license a delete, call the purge function, or assume its owner', async () => {
    const id = await seed();
    for (const statement of [
      `DELETE FROM audit_logs WHERE id = '${id}'`,
      `SELECT public.swift_purge_audit_logs(ARRAY['${id}']::text[], 'test-cleanup:ordinary')`,
      'SET LOCAL ROLE swift_audit_purge_owner',
    ]) {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL SESSION AUTHORIZATION "${probeRole}"`);
        await tx.$executeRaw`SELECT set_config('app.current_tenant', 'swift-default', true)`;
        await tx.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, 'test-cleanup:caller', true)`;
        await tx.$executeRawUnsafe(statement);
      })).rejects.toThrow(/append-only|permission denied/);
    }
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
  });
  it('the executor can select explicit ids and invoke only the dedicated purge path', async () => {
    const id = await seed();
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL SESSION AUTHORIZATION swift_audit_purge_executor');
      expect(await tx.auditLog.count({ where: { id } })).toBe(1);
      const [result] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT public.swift_purge_audit_logs(ARRAY[${id}]::text[], 'test-cleanup:executor') AS count`;
      expect(result!.count).toBe(1);
    });
    expect(await prisma.auditLog.count({ where: { id } })).toBe(0);
  });
  it('protects sensitive reads from the same setting and from truncation', async () => {
    const row = await prisma.sensitiveReadLog.create({ data: {
      actorUserId: `probe-${RUN}`, action: 'AUDIT_PURGE_PROBE', capability: 'test', purpose: 'test fixture',
    } });
    readIds.push(row.id);
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, 'caller-selected-reason', true)`;
      await tx.$executeRaw`DELETE FROM sensitive_read_logs WHERE id = ${row.id}`;
    })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE sensitive_read_logs')).rejects.toThrow(/append-only/);
    expect(await purgeSensitiveReadLogs(prisma, { id: row.id }, 'test-cleanup:sensitive-probe')).toBe(1);
  });
  it('the privileged path validates its reason and explicit-id bound at the database', async () => {
    await expect(prisma.$queryRaw`SELECT public.swift_purge_audit_logs(ARRAY[]::text[], 'x')`).rejects.toThrow(/reason/);
    const tooMany = Array(1001).fill('synthetic-absent');
    await expect(prisma.$queryRaw`SELECT public.swift_purge_audit_logs(${tooMany}::text[], 'test-cleanup:bounds')`).rejects.toThrow(/1000/);
    const kept = await seed(); const removed = await seed();
    expect(await purgeAuditLogs(prisma, { id: removed }, 'test-cleanup:explicit-ids')).toBe(1);
    expect(await prisma.auditLog.count({ where: { id: kept } })).toBe(1);
  });
});

describe('[ADM-003] the exception cannot spread by copy', () => {
  const SRC = join(process.cwd(), 'src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('only the helper names the purge setting — nothing else in the tree may license a delete', () => {
    const setters = walk(SRC).filter((f) => {
      const body = readFileSync(f, 'utf8');
      return body.includes('swift.audit_purge') && !f.endsWith('lib/audit-immutability.ts') && !f.endsWith('audit-append-only.test.ts');
    });
    expect(setters).toEqual([]);
  });

  it('nothing outside the helper deletes or updates an audit row at all — including the tests, which now purge by name', () => {
    const offenders = walk(SRC).filter((f) => {
      if (f.endsWith('lib/audit-immutability.ts')) return false;
      const body = readFileSync(f, 'utf8');
      return /auditLog\.(delete|deleteMany|update|updateMany)\s*\(/.test(body)
        && !f.endsWith('audit-append-only.test.ts');
    });
    expect(offenders).toEqual([]);
  });

  it('the migration is in the tree, so a fresh database is born append-only rather than hardened later by hand', () => {
    const dir = join(process.cwd(), 'prisma', 'migrations');
    const migration = readdirSync(dir).find((d) => d.endsWith('_audit_logs_append_only'));
    expect(migration).toBeTruthy();
    const sql = readFileSync(join(dir, migration!, 'migration.sql'), 'utf8');
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "audit_logs"/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON "audit_logs"/);
  });
});
