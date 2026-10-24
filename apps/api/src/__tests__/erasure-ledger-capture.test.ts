/**
 * [Off-site erasure ledger · #1977 COORD ruling 21 Oct] Every erasure writes its ledger entry in its own
 * transaction, on real Postgres with the real triggers: the canonical account closure (AccountService)
 * leaves one entry per fact restore-erasure-ledger.sql reads from the live database, nothing personal,
 * nothing for an open account's ordinary deletes, and the ledger cannot be changed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testPrismaClient } from './helpers/test-prisma-client';
import { AccountService } from '../modules/user/account.service';

const prisma = testPrismaClient();
const ID = randomBytes(4).toString('hex');
const PHONE = `+1555${String(Date.now()).slice(-7)}`;
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const people = { kept: '', closed: '', key: '', doc: '', run: '', field: '', closedSession: '', closedAddress: '', keptSession: '' };
let since = new Date(0);

type Entry = { id: string; kind: string; entry: Record<string, unknown>; createdAt: Date };
const entriesSince = () => prisma.$queryRawUnsafe<Entry[]>(`SELECT id, kind, entry, "createdAt" FROM erasure_ledger_entry WHERE "createdAt" >= $1 ORDER BY "createdAt"`, since);
const has = (rows: Entry[], kind: string, match: Record<string, unknown>) =>
  rows.some((r) => r.kind === kind && Object.entries(match).every(([k, v]) => r.entry[k] === v));

beforeAll(async () => {
  const mk = (suffix: string, firstName: string) => prisma.user.create({ data: {
    phone: `${PHONE}${suffix}`, firstName, lastName: `Ledger${ID}`, activeRole: 'CUSTOMER', roles: ['CUSTOMER'],
    email: `${firstName.toLowerCase()}.${ID}@example.invalid`, passwordHash: 'synthetic-hash' } });
  const kept = await mk('1', 'Keeper');
  const closed = await mk('2', 'Closer');
  people.kept = kept.id; people.closed = closed.id;
  for (const u of [kept, closed]) {
    const s = await prisma.session.create({ data: { userId: u.id, token: digest(`t-${u.id}`), refreshToken: digest(`r-${u.id}`), deviceId: 'd', deviceType: 'ios', expiresAt: new Date(Date.now() + 86_400_000) } });
    const a = await prisma.address.create({ data: { userId: u.id, label: 'Home', addressLine1: 'Synthetic 1', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15 } });
    if (u.id === closed.id) { people.closedSession = s.id; people.closedAddress = a.id; } else people.keptSession = s.id;
  }
  people.key = `verification/${closed.id}/doc-${ID}.enc`;
  await prisma.encryptedObject.create({ data: { fileKey: people.key, iv: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), wrappedDek: Buffer.from('synthetic-wrapped-key'), mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64), createdBy: closed.id } });
  const doc = await prisma.verificationDocument.create({ data: { userId: closed.id, role: 'CUSTOMER', docType: 'national_id', fileUrl: people.key } });
  people.doc = doc.id;
  const run = await prisma.extractionRun.create({ data: { submissionId: doc.id, profileCode: 'p', engineName: 'synthetic', engineVersion: '1', startedAt: new Date(), outcome: 'OK', wrappedDek: Buffer.from('synthetic-run-key') } });
  const field = await prisma.extractedField.create({ data: { runId: run.id, submissionId: doc.id, fieldCode: 'name', source: 'OCR_VLM', valueCt: Buffer.from('synthetic-value') } });
  people.run = run.id; people.field = field.id;
  since = (await prisma.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT now()::timestamp(3) AS now`))[0]!.now;
  const app = { prisma, log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, io: { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } } };
  await new AccountService(app as never).deleteAccount(people.closed);
}, 120_000);

afterAll(async () => { await prisma.$disconnect(); });

describe('every erasure writes its off-site ledger entry, in its own transaction', () => {
  it('the account closure leaves one entry per erased fact', async () => {
    const rows = await entriesSince();
    expect(has(rows, 'closed_accounts', { id: people.closed, phone: `deleted:${people.closed}` }), 'closed account').toBe(true);
    expect(has(rows, 'destroyed_keys', { fileKey: people.key, createdBy: people.closed }), 'destroyed key').toBe(true);
    expect(has(rows, 'retired_documents', { id: people.doc, userId: people.closed }), 'retired document').toBe(true);
    expect(has(rows, 'shredded_runs', { id: people.run }), 'shredded run').toBe(true);
    expect(has(rows, 'shredded_fields', { id: people.field }), 'shredded value').toBe(true);
    expect(has(rows, 'receipts', { subjectId: people.closed }), 'deletion receipt').toBe(true);
    // The tombstone entry lists what the closure KEPT: the session and the saved address it removed are not kept.
    const closedEntry = rows.find((r) => r.kind === 'closed_accounts' && r.entry['id'] === people.closed)!;
    const kept = closedEntry.entry['kept'] as Array<{ tbl: string; id: string }>;
    expect(Array.isArray(kept)).toBe(true);
    expect(kept.some((k) => k.id === people.closedSession || k.id === people.closedAddress)).toBe(false);
    expect(rows.filter((r) => r.kind === 'closed_accounts' && r.entry['id'] === people.closed), 'one tombstone entry').toHaveLength(1);
  });

  it("a closed account's row deleted after the closure (a late write swept, a hold released) is an entry too", async () => {
    const late = await prisma.address.create({ data: { userId: people.closed, label: 'Late', addressLine1: 'Synthetic 2', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15 } });
    await prisma.address.delete({ where: { id: late.id } });
    expect(has(await entriesSince(), 'deleted_rows', { tbl: 'addresses', id: late.id })).toBe(true);
  });

  it('the entries carry ids, timestamps and de-identified columns only, never the person', async () => {
    const text = JSON.stringify(await entriesSince());
    for (const personal of [`${PHONE}2`, 'Closer', `Ledger${ID}`, `closer.${ID}@example.invalid`, 'synthetic-hash', 'Synthetic 1', 'Synthetic 2']) {
      expect(text, personal).not.toContain(personal);
    }
  });

  it("an open account's ordinary delete (a logout) is not an erasure and writes nothing", async () => {
    await prisma.session.delete({ where: { id: people.keptSession } });
    const rows = await entriesSince();
    expect(rows.some((r) => JSON.stringify(r.entry).includes(people.kept))).toBe(false);
    expect(rows.some((r) => r.entry['id'] === people.keptSession)).toBe(false);
  });

  it('the ledger is append-only', async () => {
    const [row] = await entriesSince();
    await expect(prisma.$executeRawUnsafe(`UPDATE erasure_ledger_entry SET kind = kind WHERE id = $1::uuid`, row!.id)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM erasure_ledger_entry WHERE id = $1::uuid`, row!.id)).rejects.toThrow(/append-only/);
  });

  it('the application role reads the ledger and can never write it', async () => {
    const role = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_app') AS ok`);
    if (!role[0]!.ok) return; // a database without the least-privilege role (it is created by its own migration)
    const rights = await prisma.$queryRawUnsafe<Array<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }>>(
      `SELECT has_table_privilege('swift_app', 'erasure_ledger_entry', 'SELECT') AS sel, has_table_privilege('swift_app', 'erasure_ledger_entry', 'INSERT') AS ins,
              has_table_privilege('swift_app', 'erasure_ledger_shipment', 'INSERT') AS upd, has_table_privilege('swift_app', 'erasure_ledger_shipment', 'DELETE') AS del`);
    expect(rights[0]).toEqual({ sel: true, ins: false, upd: false, del: false });
  });

  it('[#1984 REVIEW-M S4-3] the trigger waits for exactly the tombstone AccountService writes (a changed literal is red here)', () => {
    const service = readFileSync(join(__dirname, '../modules/user/account.service.ts'), 'utf8');
    const migration = readFileSync(join(__dirname, '../../prisma/migrations/20261021140000_offsite_erasure_ledger/migration.sql'), 'utf8');
    const tombstone = service.slice(service.indexOf("firstName: 'Deleted'") - 200, service.indexOf("firstName: 'Deleted'") + 400);
    for (const literal of ["firstName: 'Deleted'", "lastName: 'User'", 'email: null', 'passwordHash: null', 'avatar: null', 'lastKnownLat: null', 'lastKnownLng: null', 'phone: `deleted:${userId}`']) {
      expect(tombstone, literal).toContain(literal);
    }
    expect(migration).toContain(`AND NEW."firstName" = 'Deleted' AND NEW."lastName" = 'User' AND NEW.email IS NULL AND NEW."passwordHash" IS NULL`);
    expect(migration).toContain(`AND NEW.avatar IS NULL AND NEW."lastKnownLat" IS NULL AND NEW."lastKnownLng" IS NULL`);
    expect(migration).toContain(`NEW.phone = 'deleted:' || NEW.id`);
  });

  it('every table the restore replay deletes from has its capture trigger (a new one is red here)', async () => {
    const replay = readFileSync(join(__dirname, '../../../../deploy/restore-replay-erasures.sql'), 'utf8');
    const tables = [...replay.matchAll(/DELETE FROM ("?[A-Za-z_]+"?) t USING restore_closed_ids/g)].map((m) => m[1]!.replace(/"/g, ''));
    expect(tables.length).toBeGreaterThan(10);
    const triggers = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'erasure_ledger_deleted_row' AND NOT t.tgisinternal`);
    const have = new Set(triggers.map((t) => t.relname));
    expect(tables.filter((t) => !have.has(t))).toEqual([]);
  });
});
