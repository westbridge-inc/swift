import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { AUDIT_PURGE_SETTING, purgeAuditLogs } from '../lib/audit-immutability';

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

async function seed(action = 'ADM003_SEED'): Promise<string> {
  const row = await prisma.auditLog.create({
    data: { action, entity: `AuditProbe${RUN}`, entityId: `probe-${nanoid(6)}`, changes: { before: 1 } },
  });
  ids.push(row.id);
  return row.id;
}

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await purgeAuditLogs(prisma, { entity: `AuditProbe${RUN}` }, 'test-cleanup:audit-append-only');
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

  it('TRUNCATE is refused — a row trigger does not fire for it, so it has its own', async () => {
    await seed();
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
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

describe('[ADM-003] the one exception is a transaction that names itself', () => {
  it('a purge removes rows only under a stated reason, and the licence dies with its transaction', async () => {
    const id = await seed('ADM003_PURGEABLE');
    const removed = await purgeAuditLogs(prisma, { id }, 'retention:adm003-suite');
    expect(removed).toBe(1);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(0);

    // the setting was transaction-local: the very next delete is refused again
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
    // is_local = false would be a licence for the whole session; the helper
    // uses true. Prove the shape the helper relies on: a separate statement's
    // local setting is gone by the time an unbatched delete runs.
    await prisma.$executeRaw`SELECT set_config(${AUDIT_PURGE_SETTING}, 'not-a-batch', true)`;
    await expect(prisma.auditLog.deleteMany({ where: { id } })).rejects.toThrow(/append-only/);
    expect(await prisma.auditLog.count({ where: { id } })).toBe(1);
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
