import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { SosService } from '../modules/safety/sos.service';
import { RETRIGGER_SUMMARY_CAP, importLegacyRetriggers, scanSosRetriggers } from '../modules/safety/sos-retrigger';

// ---------------------------------------------------------------------------
// [S-02] Concurrent SOS retriggers lose facts and the JSON array is unbounded.
//
// The register's red test: barrier two retriggers with different coordinates
// and request ids — both facts must exist once. Around it: a retried request
// appends once; the hot row's summary is bounded while the rows are the full
// record; a fact once written cannot be rewritten; a lost sequence is named
// by the scan; legacy JSON history is imported as rows, idempotently.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) } as unknown as Server;
let sos: SosService;
const alertIds: string[] = [];
const u = () => 'u-s02-' + nanoid(8);
const rowsOf = (id: string) => prisma.sosRetrigger.findMany({ where: { sosAlertId: id }, orderBy: { seq: 'asc' } });
const alertOf = (id: string) => prisma.sosAlert.findUniqueOrThrow({ where: { id } });
const track = <T extends { id: string }>(a: T) => { alertIds.push(a.id); return a; };

beforeAll(async () => { await prisma.$connect(); sos = new SosService(prisma, io); });
beforeEach(() => { sos.observer = {}; });
afterAll(async () => {
  await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await prisma.$disconnect();
});

describe('the register’s red test: two retriggers at once', () => {
  it('both facts exist once, each with its own sequence number; the count and the summary agree; the last committed position is operative', async () => {
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.80, lng: -58.15, clientIdempotencyKey: `k-${nanoid(6)}` }));
    // The barrier: both retriggers read the live alert, then both proceed.
    let arrived = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sos.observer = { afterReadLive: async () => { arrived += 1; if (arrived === 2) release(); await gate; } };
    const [a, b] = await Promise.all([
      sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.81, lng: -58.16, accuracyM: 12, clientIdempotencyKey: `r1-${nanoid(6)}` }),
      sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.82, lng: -58.17, accuracyM: 9, clientIdempotencyKey: `r2-${nanoid(6)}` }),
    ]);
    expect(a.id).toBe(first.id); expect(b.id).toBe(first.id);
    const rows = await rowsOf(first.id);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.map((r) => r.lat).sort()).toEqual([6.81, 6.82]);
    expect(rows.every((r) => r.requestKey !== null)).toBe(true);
    const after = await alertOf(first.id);
    expect(after.retriggerCount).toBe(2);
    const summary = after.retriggers as Array<{ seq: number; lat: number }>;
    expect(summary.map((s) => s.seq)).toEqual([1, 2]);
    expect(summary.map((s) => s.lat).sort()).toEqual([6.81, 6.82]);
    // whichever committed last is where the person is now
    expect(rows.find((r) => r.seq === 2)!.lat).toBe(after.triggerLat);
  });
});

describe('idempotency, bounds, immutability, scan, import', () => {
  it('a retried retrigger request (same request key) appends once and does not count twice; a keyless press still appends', async () => {
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', clientIdempotencyKey: `k-${nanoid(6)}` }));
    const key = `retry-${nanoid(6)}`;
    await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.83, lng: -58.18, clientIdempotencyKey: key });
    await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.83, lng: -58.18, clientIdempotencyKey: key });
    expect(await rowsOf(first.id)).toHaveLength(1);
    expect((await alertOf(first.id)).retriggerCount).toBe(1);
    await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.84, lng: -58.19 });
    const rows = await rowsOf(first.id);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]!.requestKey).toBeNull();
    expect((await alertOf(first.id)).retriggerCount).toBe(2);
  });
  it('the hot row’s summary is bounded to the newest rows while every fact stays a row', async () => {
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    const n = RETRIGGER_SUMMARY_CAP + 5;
    for (let i = 1; i <= n; i += 1) await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.8 + i / 1000, lng: -58.15 });
    expect(await prisma.sosRetrigger.count({ where: { sosAlertId: first.id } })).toBe(n);
    const after = await alertOf(first.id);
    expect(after.retriggerCount).toBe(n);
    const summary = after.retriggers as Array<{ seq: number }>;
    expect(summary).toHaveLength(RETRIGGER_SUMMARY_CAP);
    expect(summary[0]!.seq).toBe(n - RETRIGGER_SUMMARY_CAP + 1);
    expect(summary[summary.length - 1]!.seq).toBe(n);
    expect((await scanSosRetriggers(prisma)).oversized).not.toContain(first.id);
  });
  it('a fact, once written, cannot be rewritten', async () => {
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.85, lng: -58.2 });
    const [row] = await rowsOf(first.id);
    await expect(prisma.sosRetrigger.update({ where: { id: row!.id }, data: { lat: 0, lng: 0 } })).rejects.toThrow(/immutable/);
    expect((await rowsOf(first.id))[0]!.lat).toBe(6.85);
  });
  it('the scan names an alert whose rows do not account for its count, and clears once they do', async () => {
    const who = u();
    const first = track(await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON' }));
    for (let i = 0; i < 3; i += 1) await sos.create({ actorUserId: who, actorRole: 'CUSTOMER', triggerSource: 'BUTTON', lat: 6.86, lng: -58.2 });
    expect((await scanSosRetriggers(prisma)).gaps.some((g) => g.sosAlertId === first.id)).toBe(false);
    await prisma.sosRetrigger.deleteMany({ where: { sosAlertId: first.id, seq: 2 } });
    const gap = (await scanSosRetriggers(prisma)).gaps.find((g) => g.sosAlertId === first.id);
    expect(gap).toMatchObject({ retriggerCount: 3, rows: 2, maxSeq: 3 });
  });
  it('legacy JSON history is imported as rows in order, the summary is rebuilt, and a second import changes nothing', async () => {
    const legacy = track(await prisma.sosAlert.create({ data: {
      actorUserId: u(), actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', retriggerCount: 2, lastRetriggerAt: new Date(),
      retriggers: [
        { at: '2026-09-01T10:00:00.000Z', source: 'BUTTON', lat: 6.9, lng: -58.1, accuracyM: 20, addressText: null, counterpartyUserId: null, actorRole: 'CUSTOMER', clientCreatedAt: null },
        { at: '2026-09-01T10:00:30.000Z', source: 'GUARDIAN_ESCALATION', lat: 6.91, lng: -58.11, accuracyM: 5, addressText: 'Camp St', counterpartyUserId: null, actorRole: 'CUSTOMER', clientCreatedAt: '2026-09-01T10:00:29.000Z' },
      ],
    } }));
    expect((await scanSosRetriggers(prisma)).legacy).toContain(legacy.id);
    const first = await importLegacyRetriggers(prisma);
    expect(first.imported).toContain(legacy.id);
    const rows = await rowsOf(legacy.id);
    expect(rows.map((r) => [r.seq, r.source, r.lat, r.addressText])).toEqual([[1, 'BUTTON', 6.9, null], [2, 'GUARDIAN_ESCALATION', 6.91, 'Camp St']]);
    expect(rows[1]!.clientCreatedAt?.toISOString()).toBe('2026-09-01T10:00:29.000Z');
    const scan = await scanSosRetriggers(prisma);
    expect(scan.legacy).not.toContain(legacy.id);
    expect(scan.gaps.some((g) => g.sosAlertId === legacy.id)).toBe(false);
    const summary = (await alertOf(legacy.id)).retriggers as Array<{ seq: number }>;
    expect(summary.map((s) => s.seq)).toEqual([1, 2]);
    await importLegacyRetriggers(prisma);
    expect(await prisma.sosRetrigger.count({ where: { sosAlertId: legacy.id } })).toBe(2);
  });
});
