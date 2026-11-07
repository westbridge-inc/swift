/**
 * [Row 312 · security review on #2010, COORD rule 21 Oct] "The scanner is down" is a FACT about the
 * scanner, never about a file.
 *
 *  - The 'UNSCANNED' fallback (evidence always; the bypass surfaces under MALWARE_SCAN_BYPASS=1) applies
 *    ONLY when clamd is UNREACHABLE: the connection itself failed (refused, no route, no such name,
 *    connect timeout, or no usable scanner address) AND a fresh PING fails too.
 *  - clamd reachable but erroring, closing or timing out on THIS payload (size limit, archive bomb,
 *    malformed stream) is never "down": a crafted file must not buy itself an unscanned pass.
 *      - the bypass surfaces are REFUSED, even with the bypass on;
 *      - evidence (safety evidence, delivery and handover proof) is never lost: the route stores it
 *        straight into the QUARANTINE (held) folder, which nothing serves, writes the debt row
 *        (HELD) and ops are paged; it leaves the quarantine only on a CLEAN scan.
 *  - [COORD 22 Oct, security review M-1] evidence stored while the scanner is UNREACHABLE goes into the
 *    held folder too, never its normal folder: unservable and unadmissible until the rescan answers
 *    CLEAN, which moves it out. And a payload that fails mid-scan starts a cool-down: for
 *    PAYLOAD_FAILURE_COOLDOWN_MS no upload earns the bypass's unscanned pass, even if clamd then looks
 *    down (a file that crashes clamd must never make the next upload look "down"), shared via Redis.
 *  - [COORD 22 Oct, M-2] custody never waits for the scanner; a claim admits a held photo only once a
 *    clean scan released it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../modules/ops/ops-page', () => ({
  pageOps: vi.fn(async () => ({ status: 'delivered', opsAlertId: 'a1', recipients: 1 })),
  resolveOpsPage: vi.fn(async () => 1),
}));

import { pageOps } from '../modules/ops/ops-page';
import { BYPASS_SURFACES, NEVER_REFUSED_SURFACES, PAYLOAD_FAILURE_COOLDOWN_KEY, PAYLOAD_FAILURE_COOLDOWN_MS, memoryScannerCooldown, redisScannerCooldown, scanUpload, registerScannerCooldown } from '../lib/malware-scan';
import {
  QUARANTINE_HELD_FOLDER, assertServableKey, evidenceAdmissible, evidenceObjectKey, heldFolder, isQuarantineKey, recordUnscannedUpload,
  rescanUploadDebt, retryHeldEvidenceScan,
} from '../lib/upload-scan-debt';
import { PUBLIC_UPLOAD_FOLDERS } from '../utils/public-uploads';
import { EVIDENCE_HELD_PAGE_TITLE, watchMalwareScanner } from '../modules/ops/malware-scanner-watch';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';

const servers: net.Server[] = [];
// The cool-down is module state: every test starts without one.
beforeEach(() => registerScannerCooldown(memoryScannerCooldown()));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(pageOps).mockClear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A REACHABLE clamd: answers PING, and does `onScan` with every INSTREAM. */
async function reachable(onScan: 'error-reply' | 'close' | 'hang') {
  const server = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      const text = data.toString('utf8');
      if (text.startsWith('zPING\0')) { socket.end('PONG\0'); return; }
      if (!text.startsWith('zINSTREAM\0')) return;
      if (onScan === 'error-reply') socket.end('INSTREAM size limit exceeded. ERROR\0');
      if (onScan === 'close') socket.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String((server.address() as net.AddressInfo).port) } as Record<string, string | undefined>;
}
const log = () => ({ warn: vi.fn(), error: vi.fn() });
const DOWN = { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '1' } as Record<string, string | undefined>;
const EVIDENCE = ['safety-evidence', 'courier-proof', 'handover-proof'] as const;

describe('unreachable (connection failed AND a fresh PING fails) -> UNSCANNED', () => {
  it('evidence always, the bypass surfaces only with the bypass', async () => {
    for (const surface of EVIDENCE) await expect(scanUpload(Buffer.from('x'), { surface, log: log() }, DOWN), surface).resolves.toBe('UNSCANNED');
    for (const surface of BYPASS_SURFACES) {
      await expect(scanUpload(Buffer.from('x'), { surface, log: log() }, { ...DOWN, MALWARE_SCAN_BYPASS: '1' }), surface).resolves.toBe('UNSCANNED');
      await expect(scanUpload(Buffer.from('x'), { surface, log: log() }, DOWN), surface).rejects.toMatchObject({ statusCode: 503 });
    }
  });

  it('a failed connection is NOT "down" while a fresh PING answers: treated as this payload failing', async () => {
    const env = await reachable('error-reply');
    const real = net.createConnection;
    let first = true;
    vi.spyOn(net, 'createConnection').mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
      if (!first) return real(...args);
      first = false; // the scan's own connection fails before it connects ...
      const socket = new net.Socket();
      setImmediate(() => socket.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })));
      return socket;
    }) as typeof net.createConnection);
    // ... but the scanner answers PING: refused under the bypass, held as evidence.
    await expect(scanUpload(Buffer.from('x'), { surface: 'liveness', log: log() }, { ...env, MALWARE_SCAN_BYPASS: '1' })).rejects.toMatchObject({ statusCode: 503 });
    first = true;
    await expect(scanUpload(Buffer.from('x'), { surface: 'handover-proof', log: log() }, env)).resolves.toBe('QUARANTINE');
  });
});

describe('reachable, but THIS payload errors, closes or times out -> never an unscanned pass', () => {
  for (const behaviour of ['error-reply', 'close', 'hang'] as const) {
    it(`${behaviour}: the bypass surfaces are refused even with the bypass on; evidence is held in quarantine`, async () => {
      const env = await reachable(behaviour);
      for (const surface of BYPASS_SURFACES) {
        await expect(scanUpload(Buffer.from('crafted'), { surface, log: log() }, { ...env, MALWARE_SCAN_BYPASS: '1' }, { timeoutMs: 300 }), surface)
          .rejects.toMatchObject({ statusCode: 503 });
      }
      for (const surface of EVIDENCE) {
        const l = log();
        await expect(scanUpload(Buffer.from('crafted'), { surface, log: l }, env, { timeoutMs: 300 }), surface).resolves.toBe('QUARANTINE');
        expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ surface }), expect.stringMatching(/quarantine/i));
      }
    });
  }
  it('a file that KILLS the scanner mid-scan is not "down" even though the PING after it fails: refused / held', async () => {
    for (const [surface, env0, expected] of [
      ['liveness', { MALWARE_SCAN_BYPASS: '1' }, 'refused'],
      ['handover-proof', {}, 'QUARANTINE'],
    ] as const) {
      const server = net.createServer((socket) => {
        socket.on('data', (chunk) => {
          if (!chunk.toString('utf8').startsWith('zINSTREAM\0')) return;
          socket.destroy();
          server.close(); // the scanner is gone: the fresh PING fails too
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const env = { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String((server.address() as net.AddressInfo).port), ...env0 };
      const outcome = scanUpload(Buffer.from('crafted'), { surface, log: log() }, env, { timeoutMs: 500 });
      if (expected === 'refused') await expect(outcome).rejects.toMatchObject({ statusCode: 503 });
      else await expect(outcome).resolves.toBe('QUARANTINE');
    }
  });

  it('evidence is exactly safety evidence, delivery and handover proof', () => {
    expect([...NEVER_REFUSED_SURFACES].sort()).toEqual([...EVIDENCE].sort());
  });
});

// ---------------------------------------------------------------------------
// Held evidence: stored straight into the quarantine folder, recorded, never served, released by hand.
// ---------------------------------------------------------------------------
function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    uploadScanDebt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `h${rows.length + 1}`, releasedAt: null, ...data }; rows.push(row); return row; }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      count: vi.fn(async () => 0),
    },
  };
}
const storage = () => ({ delete: vi.fn(async () => undefined) });

describe('held evidence', () => {
  it('[M-1] the route stores anything not scanned CLEAN in the held quarantine folder: unreachable or failing alike', () => {
    for (const outcome of ['QUARANTINE', 'UNSCANNED'] as const) expect(heldFolder(outcome, 'handover-proof/o1'), outcome).toBe(`${QUARANTINE_HELD_FOLDER}/handover-proof/o1`);
    for (const outcome of ['CLEAN', 'SKIPPED'] as const) expect(heldFolder(outcome, 'handover-proof/o1')).toBe('handover-proof/o1');
  });

  it('[M-1] evidence recorded anywhere but the held folder is never kept: deleted and refused', async () => {
    for (const outcome of ['UNSCANNED', 'QUARANTINE'] as const) {
      const db = fakeDb();
      const s = storage();
      await expect(recordUnscannedUpload(db as never, outcome, { surface: 'courier-proof', fileKey: 'courier-proof/o1/pickup/a.jpg', buffer: Buffer.from('p'), storage: s as never }))
        .rejects.toMatchObject({ statusCode: 503 });
      expect(s.delete).toHaveBeenCalledWith('courier-proof/o1/pickup/a.jpg');
      expect(db.rows).toHaveLength(0);
    }
    // In the held folder it is recorded: an open row for the rescan (unreachable) ...
    const db = fakeDb();
    await recordUnscannedUpload(db as never, 'UNSCANNED', { surface: 'courier-proof', fileKey: `/uploads/${QUARANTINE_HELD_FOLDER}/courier-proof/o1/pickup/a.jpg`, buffer: Buffer.from('p'), storage: storage() as never }, {});
    expect(db.rows[0]).toMatchObject({ reason: 'evidence', surface: 'courier-proof' });
    expect(db.rows[0]!['result']).toBeUndefined(); // open: the rescan takes it
  });

  it('is recorded HELD (quarantined, evidence) with no person id; a failed record deletes it and refuses', async () => {
    const db = fakeDb();
    const key = `${QUARANTINE_HELD_FOLDER}/handover-proof/o1/abc.jpg`;
    await recordUnscannedUpload(db as never, 'QUARANTINE', { surface: 'handover-proof', fileKey: key, buffer: Buffer.from('p'), storage: storage() as never });
    expect(db.rows[0]).toMatchObject({ surface: 'handover-proof', reason: 'evidence', result: 'HELD', fileKey: key, quarantineKey: key, quarantinedAt: expect.any(Date) });
    const failing = fakeDb();
    failing.uploadScanDebt.create.mockRejectedValueOnce(new Error('db down'));
    const s = storage();
    await expect(recordUnscannedUpload(failing as never, 'QUARANTINE', { surface: 'courier-proof', fileKey: key, buffer: Buffer.from('p'), storage: s as never }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(s.delete).toHaveBeenCalledWith(key);
  });

  it('nothing serves a quarantined object: both storage adapters refuse to sign one, and no public folder is one', () => {
    expect(PUBLIC_UPLOAD_FOLDERS.filter((f) => isQuarantineKey(f) || f.startsWith('quarantine'))).toEqual([]);
    for (const key of ['quarantine/held/x/a.jpg', '/uploads/quarantine/uploads/1/q.bin', 'quarantine/uploads/2/q.bin']) {
      expect(isQuarantineKey(key), key).toBe(true);
      expect(() => assertServableKey(key), key).toThrow();
    }
    for (const key of ['handover-proof/o1/a.jpg', '/uploads/avatars/u/a.jpg', 'chat/r/quarantine.jpg']) expect(isQuarantineKey(key), key).toBe(false);
    const src = readFileSync(join(__dirname, '..', 'providers', 'storage', 'storage-provider.ts'), 'utf8');
    const signers = src.split('async getSignedUrl(').slice(1);
    expect(signers).toHaveLength(2);
    for (const body of signers) expect(body.slice(0, 300)).toContain('assertServableKey(fileKey)');
  });

  it('evidence is never lost: the 30-day purge takes only positive or unscannable copies, never HELD evidence, and keeps the release map', async () => {
    const findMany = vi.fn(async (_args: { where: Record<string, unknown> }) => [] as unknown[]);
    const deleteMany = vi.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 0 }));
    const prisma = { uploadScanDebt: { findMany, updateMany: vi.fn(), deleteMany }, encryptedObject: { findUnique: vi.fn() } };
    const env = await reachable('error-reply'); // answers PING: the pass runs
    await rescanUploadDebt({ prisma: prisma as never, redis: {} as never, notifications: {} as never, storage: { getObject: vi.fn(), upload: vi.fn(), delete: vi.fn() } as never, env });
    const purge = findMany.mock.calls.map(([args]) => args.where).find((w) => 'quarantineKey' in w);
    expect(purge).toMatchObject({ result: { in: ['FOUND', 'UNSCANNABLE'] } });
    expect(deleteMany.mock.calls[0]![0]).toMatchObject({ where: { quarantinedAt: null, releasedKey: null } });
  });

  it('ops are paged while evidence is held and not released', async () => {
    const prisma = { uploadScanDebt: { count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (where['result'] === 'HELD' ? 2 : 0)) } };
    await watchMalwareScanner({ prisma: prisma as never, redis: { del: vi.fn(), incr: vi.fn(), expire: vi.fn() } as never, notifications: {} as never }, { MALWARE_SCAN: 'clamd' }, async () => ({ state: 'ok' }));
    const page = vi.mocked(pageOps).mock.calls.find(([, i]) => i.title === EVIDENCE_HELD_PAGE_TITLE);
    expect(page![1]).toMatchObject({ data: { kind: 'ops_evidence_held', held: 2 } });
  });
});

// ---------------------------------------------------------------------------
// [COORD 22 Oct · security review M-1] A payload that fails mid-scan must never make the NEXT upload
// look "down": the payload-failure cool-down.
// ---------------------------------------------------------------------------
describe('[M-1] the payload-failure cool-down', () => {
  /** A clamd that dies on the first INSTREAM it sees (and stays down: the PING after it fails too). */
  async function crashOnFirstScan() {
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        if (!chunk.toString('utf8').startsWith('zINSTREAM\0')) return;
        socket.destroy();
        server.close();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String((server.address() as net.AddressInfo).port), MALWARE_SCAN_BYPASS: '1' } as Record<string, string | undefined>;
  }

  it('a file that crashes clamd: the NEXT bypass upload, with clamd now unreachable, is refused (no unscanned pass); evidence is still held', async () => {
    const env = await crashOnFirstScan();
    await expect(scanUpload(Buffer.from('crafted'), { surface: 'liveness', log: log() }, env, { timeoutMs: 500 })).rejects.toMatchObject({ statusCode: 503 });
    // clamd is gone now: connection refused AND PING fails = "unreachable" ... but a payload just failed.
    const l = log();
    await expect(scanUpload(Buffer.from('the attacker\'s real payload'), { surface: 'liveness', log: l }, env, { timeoutMs: 500 })).rejects.toMatchObject({ statusCode: 503 });
    expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ cooling: true }), expect.stringMatching(/cool-down/));
    // Evidence is never refused, and held either way (never served before a clean scan).
    await expect(scanUpload(Buffer.from('proof'), { surface: 'courier-proof', log: log() }, env, { timeoutMs: 500 })).resolves.toBe('UNSCANNED');
  });

  it('the cool-down ends PAYLOAD_FAILURE_COOLDOWN_MS after the last payload failure; a genuine outage then gets the bypass again', async () => {
    let now = 1_000_000;
    registerScannerCooldown(memoryScannerCooldown(() => now));
    const env = await crashOnFirstScan();
    await expect(scanUpload(Buffer.from('crafted'), { surface: 'liveness', log: log() }, env, { timeoutMs: 500 })).rejects.toMatchObject({ statusCode: 503 });
    now += PAYLOAD_FAILURE_COOLDOWN_MS - 1;
    await expect(scanUpload(Buffer.from('x'), { surface: 'verification', log: log() }, env, { timeoutMs: 500 })).rejects.toMatchObject({ statusCode: 503 });
    now += 2;
    await expect(scanUpload(Buffer.from('x'), { surface: 'verification', log: log() }, env, { timeoutMs: 500 })).resolves.toBe('UNSCANNED');
  });

  it('a payload error on a scanner that stays up starts it too (a delayed crash cannot buy a pass)', async () => {
    const env = await reachable('error-reply');
    await expect(scanUpload(Buffer.from('crafted'), { surface: 'liveness', log: log() }, { ...env, MALWARE_SCAN_BYPASS: '1' })).rejects.toMatchObject({ statusCode: 503 });
    // The scanner is now unreachable for real: still no pass inside the cool-down.
    await expect(scanUpload(Buffer.from('x'), { surface: 'liveness', log: log() }, { ...DOWN, MALWARE_SCAN_BYPASS: '1' })).rejects.toMatchObject({ statusCode: 503 });
  });

  it('without any payload failure, a genuine outage gets the bypass (the cool-down only follows a failed payload)', async () => {
    await expect(scanUpload(Buffer.from('x'), { surface: 'liveness', log: log() }, { ...DOWN, MALWARE_SCAN_BYPASS: '1' })).resolves.toBe('UNSCANNED');
  });

  it('shared through Redis: a failure on one replica cools every replica; a Redis that errors or stalls reads as cooling (fail closed)', async () => {
    const store = new Map<string, number>();
    const redis = {
      set: vi.fn(async (key: string, _v: string, _m: 'PX', ms: number) => { store.set(key, ms); return 'OK'; }),
      exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    };
    const replicaA = redisScannerCooldown(redis);
    const replicaB = redisScannerCooldown(redis);
    await expect(replicaB.active()).resolves.toBe(false);
    await replicaA.start();
    expect(store.get(PAYLOAD_FAILURE_COOLDOWN_KEY)).toBe(PAYLOAD_FAILURE_COOLDOWN_MS);
    await expect(replicaB.active()).resolves.toBe(true);
    const broken = redisScannerCooldown({ set: vi.fn(async () => { throw new Error('down'); }), exists: vi.fn(async () => { throw new Error('down'); }) });
    await expect(broken.active()).resolves.toBe(true);
    await expect(broken.start()).resolves.toBeUndefined();
    const stalled = redisScannerCooldown({ set: vi.fn(() => new Promise<never>(() => undefined)), exists: vi.fn(() => new Promise<never>(() => undefined)) }, memoryScannerCooldown(), 50);
    await expect(stalled.active()).resolves.toBe(true);
  });

  it('the API and the worker register the Redis-backed cool-down at boot', () => {
    for (const file of ['app.ts', 'worker.ts']) {
      expect(readFileSync(join(__dirname, '..', file), 'utf8'), file).toMatch(/registerScannerCooldown\(redisScannerCooldown\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// [COORD 22 Oct · M-1/M-2] Held evidence leaves the quarantine only on a CLEAN scan, and only then is it
// admitted as proof.
// ---------------------------------------------------------------------------
const CLEAN_BYTES = Buffer.from('a clean proof photo');
const BAD_BYTES = Buffer.from('a positive');
async function verdictClamd() {
  const server = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.toString('utf8').startsWith('zPING\0')) { socket.end('PONG\0'); return; }
      const parts: Buffer[] = [];
      let at = 'zINSTREAM\0'.length;
      for (;;) {
        if (data.length < at + 4) return;
        const length = data.readUInt32BE(at);
        if (length === 0) break;
        if (data.length < at + 4 + length) return;
        parts.push(data.subarray(at + 4, at + 4 + length));
        at += 4 + length;
      }
      socket.end(Buffer.concat(parts).equals(BAD_BYTES) ? 'stream: Test-Signature FOUND\0' : 'stream: OK\0');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String((server.address() as net.AddressInfo).port) } as Record<string, string | undefined>;
}

/** An in-memory upload_scan_debts honouring the filters the code uses. */
function debtTable(rows: Array<Record<string, unknown>>) {
  const matches = (r: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([k, v]) => {
    if (v === null) return r[k] === null || r[k] === undefined;
    if (typeof v === 'object' && v && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      if ('not' in o) return o['not'] === null ? r[k] !== null && r[k] !== undefined : r[k] !== o['not'];
      if ('in' in o) return (o['in'] as unknown[]).includes(r[k]);
      if ('lt' in o) return r[k] instanceof Date && (r[k] as Date) < (o['lt'] as Date);
      return true;
    }
    return r[k] === v;
  });
  const uploadScanDebt = {
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matches(r, where))),
    findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => rows.find((r) => matches(r, where)) ?? null),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) for (const [k, v] of Object.entries(data)) r[k] = typeof v === 'object' && v && 'increment' in v ? (r[k] as number) + (v as { increment: number }).increment : v;
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  };
  const db = { rows, uploadScanDebt, encryptedObject: { findUnique: vi.fn(async () => null) }, auditLog: { create: vi.fn(async () => ({})) } } as Record<string, unknown>;
  db['$transaction'] = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db as typeof db & { rows: typeof rows; uploadScanDebt: typeof uploadScanDebt; auditLog: { create: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> };
}
function objectStore(objects: Map<string, Buffer>) {
  return {
    objects,
    upload: vi.fn(async ({ buffer, folder, filename }: { buffer: Buffer; folder: string; filename: string }) => { const url = `/uploads/${folder}/${filename}`; objects.set(url, buffer); return { url }; }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
    getObject: vi.fn(async (key: string) => { const b = objects.get(key); if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return b; }),
  };
}
const HELD = `/uploads/${QUARANTINE_HELD_FOLDER}/handover-proof/o1/abc.jpg`;
const openEvidence = (extra: Record<string, unknown> = {}) => ({
  id: 'e1', surface: 'handover-proof', reason: 'evidence', fileKey: HELD, sealed: false, sha256: 'x', attempts: 0,
  createdAt: new Date(1_000), rescannedAt: null, quarantinedAt: null, quarantineKey: null, result: null, releasedAt: null, releasedKey: null, ...extra,
});
const job = (db: ReturnType<typeof debtTable>, store: ReturnType<typeof objectStore>, env: Record<string, string | undefined>) =>
  ({ prisma: db as never, redis: {} as never, notifications: {} as never, storage: store as never, env });

describe('[M-1] held evidence: unservable and unadmissible until a CLEAN scan moves it out', () => {
  it('while held: no claim admits it and nothing resolves its bytes', async () => {
    const db = debtTable([openEvidence()]);
    await expect(evidenceAdmissible(db as never, HELD)).resolves.toBe(false);
    await expect(evidenceObjectKey(db as never, HELD)).resolves.toBeNull();
    expect(() => assertServableKey(HELD)).toThrow();
    // A key outside the quarantine was scanned clean at upload.
    await expect(evidenceAdmissible(db as never, '/uploads/handover-proof/o1/zzz.jpg')).resolves.toBe(true);
    await expect(evidenceAdmissible(db as never, null)).resolves.toBe(false);
  });

  it('the rescan answers CLEAN: the bytes move to their normal folder, the held copy is deleted, and only now it is admitted', async () => {
    const env = await verdictClamd();
    const db = debtTable([openEvidence()]);
    const store = objectStore(new Map([[HELD, CLEAN_BYTES]]));
    await expect(rescanUploadDebt(job(db, store, env))).resolves.toMatchObject({ scanned: 1, clean: 1 });
    const released = '/uploads/handover-proof/o1/abc.jpg';
    expect(store.upload).toHaveBeenCalledWith(expect.objectContaining({ folder: 'handover-proof/o1', filename: 'abc.jpg', mimeType: 'image/jpeg' }));
    expect(store.objects.get(released)!.equals(CLEAN_BYTES)).toBe(true);
    expect(store.objects.has(HELD)).toBe(false);
    // The row keeps the issued key (every record was issued it; handover proofs are immutable) beside the released one.
    expect(db.rows[0]).toMatchObject({ result: 'CLEAN', fileKey: HELD, releasedKey: released, releasedAt: expect.any(Date), rescannedAt: expect.any(Date) });
    await expect(evidenceObjectKey(db as never, HELD)).resolves.toBe(released);
    await expect(evidenceAdmissible(db as never, HELD)).resolves.toBe(true);
    expect(() => assertServableKey(released)).not.toThrow();
  });

  it('a positive is quarantined like any other (the held copy deleted) and never admitted', async () => {
    const env = await verdictClamd();
    const db = debtTable([openEvidence()]);
    const store = objectStore(new Map([[HELD, BAD_BYTES]]));
    await rescanUploadDebt(job(db, store, env));
    expect(db.rows[0]).toMatchObject({ result: 'FOUND', releasedKey: null });
    expect(store.objects.has(HELD)).toBe(false);
    await expect(evidenceAdmissible(db as never, HELD)).resolves.toBe(false);
  });

  it('rescans that run out leave evidence HELD where it is (never deleted, never admitted), unlike a bypass upload', async () => {
    const env = await verdictClamd();
    const db = debtTable([openEvidence({ attempts: 4 })]);
    const store = objectStore(new Map([[HELD, CLEAN_BYTES]]));
    store.getObject.mockImplementation(async () => { throw new Error('read timed out'); });
    await rescanUploadDebt(job(db, store, env));
    expect(db.rows[0]).toMatchObject({ result: 'HELD', quarantinedAt: expect.any(Date), quarantineKey: HELD, releasedKey: null });
    expect(store.delete).not.toHaveBeenCalled();
    await expect(evidenceAdmissible(db as never, HELD)).resolves.toBe(false);
  });
});

describe('[M-1/M-2] a platform admin retries the scan of HELD evidence: released only on a CLEAN answer', () => {
  const held = () => openEvidence({ result: 'HELD', quarantinedAt: new Date(2_000), quarantineKey: HELD });

  it('CLEAN: released (moved out), and the audit trail commits in the same transaction as the release', async () => {
    const env = await verdictClamd();
    const db = debtTable([held()]);
    const store = objectStore(new Map([[HELD, CLEAN_BYTES]]));
    const trail = vi.fn(async (tx: unknown) => { expect(tx).toBe(db); });
    await expect(retryHeldEvidenceScan(job(db, store, env) as never, 'e1', trail)).resolves.toMatchObject({ outcome: 'RELEASED' });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(trail).toHaveBeenCalledTimes(1);
    expect(db.rows[0]).toMatchObject({ result: 'CLEAN', quarantineKey: null, releasedKey: '/uploads/handover-proof/o1/abc.jpg' });
    await expect(evidenceAdmissible(db as never, HELD)).resolves.toBe(true);
    // Once released it is not held: a second retry changes nothing.
    await expect(retryHeldEvidenceScan(job(db, store, env) as never, 'e1', trail)).resolves.toEqual({ outcome: 'NOT_HELD' });
  });

  it('never on a person\'s word: scanner down or failing -> still held; a positive -> quarantined; no trail without a release', async () => {
    const trail = vi.fn(async () => undefined);
    const dbDown = debtTable([held()]);
    await expect(retryHeldEvidenceScan(job(dbDown, objectStore(new Map([[HELD, CLEAN_BYTES]])), DOWN) as never, 'e1', trail)).resolves.toMatchObject({ outcome: 'STILL_HELD' });
    const failing = await reachable('error-reply');
    const dbFail = debtTable([held()]);
    await expect(retryHeldEvidenceScan(job(dbFail, objectStore(new Map([[HELD, CLEAN_BYTES]])), failing) as never, 'e1', trail)).resolves.toMatchObject({ outcome: 'STILL_HELD' });
    const env = await verdictClamd();
    const dbBad = debtTable([held()]);
    const store = objectStore(new Map([[HELD, BAD_BYTES]]));
    await expect(retryHeldEvidenceScan(job(dbBad, store, env) as never, 'e1', trail)).resolves.toMatchObject({ outcome: 'FOUND' });
    expect(store.objects.has(HELD)).toBe(false);
    expect(trail).not.toHaveBeenCalled();
    for (const db of [dbDown, dbFail]) expect(db.rows[0]).toMatchObject({ result: 'HELD', releasedAt: null });
    // An open (not held) row, or a bypass row, is not the admin's to release.
    await expect(retryHeldEvidenceScan(job(debtTable([openEvidence()]), store, env) as never, 'e1', trail)).resolves.toEqual({ outcome: 'NOT_HELD' });
  });

  it('the admin route goes through the retried scan: C3, platform control, a reason, and no release written by hand', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /upload-scan-debts/held']).toMatchObject({ cls: 'C1' });
    expect(ADMIN_ROUTE_AUTHORITY['POST /upload-scan-debts/:id/release']).toMatchObject({ cls: 'C3' });
    const routes = readFileSync(join(__dirname, '..', 'modules', 'admin', 'admin.routes.ts'), 'utf8');
    const handler = routes.slice(routes.indexOf("app.post('/upload-scan-debts/:id/release'"), routes.indexOf('/** DELETE /dlq/:queue/:id'));
    expect(handler).toMatch(/platformControlGuard/);
    expect(handler).toMatch(/retryHeldEvidenceScan\(/);
    expect(handler).toMatch(/auditIn\(tx, request\.user\.userId, 'RELEASE_HELD_UPLOAD'/);
    expect(handler).not.toMatch(/releasedAt|releaseHeldEvidence\(/);
  });
});

// ---------------------------------------------------------------------------
// [COORD 22 Oct · M-2] Custody never waits for the scanner, but a claim or dispute admits a held proof
// photo only once a clean scan released it.
// ---------------------------------------------------------------------------
describe('[M-2] a claim admits a door photo held for its scan only after a CLEAN release', () => {
  it('held: the filing is bound but the photo is not admitted; released clean: admitted; never held: admitted', async () => {
    const { admittedHandoverEvidence, handoverBinding, HANDOVER_POLICY_VERSION } = await import('../modules/cash/handover-evidence');
    const order = {
      id: 'o1', tenantId: 't1', customerId: 'c1', riderId: 'r1', driverId: null, orderType: 'COURIER', paymentMethod: 'CASH', courierPayer: 'RECIPIENT',
      deliveryLat: 6.8, deliveryLng: -58.1, pickupLat: 6.81, pickupLng: -58.11, subtotalBase: 1000, totalAmount: 1200,
      pickedUpAt: new Date(1_000), acceptedAt: new Date(500), status: 'FAILED', paymentStatus: 'FAILED', deliveredAt: null,
    } as never;
    const binding = handoverBinding(order);
    const evidence = {
      id: 'ev1', actorId: 'u1', invalidatedAt: null, orderId: 'o1', tenantId: 't1', customerId: 'c1', riderId: 'r1', driverId: null,
      outcome: 'no_show', orderType: 'COURIER', bindingDigest: binding, policyVersion: HANDOVER_POLICY_VERSION, filedAt: new Date(10_000),
      sourceStatus: 'ARRIVED', photoProofId: 'p1', locationAt: null, locationLat: null, locationLng: null, maxLocationAgeMs: 0, maxDistanceKm: 0,
    };
    const proof = (objectKey: string) => ({
      id: 'p1', invalidatedAt: null, orderId: 'o1', tenantId: 't1', customerId: 'c1', actorId: 'u1', riderId: 'r1', driverId: null,
      purpose: 'HANDOVER', sourceStatus: 'ARRIVED', bindingDigest: binding, issuedAt: new Date(5_000), objectKey,
    });
    const claim = { handoverEvidenceId: 'ev1', riderId: 'r1', driverId: null, customerId: 'c1', reason: 'no_show' };
    const db = (objectKey: string, debts: Array<Record<string, unknown>>) => ({
      ...debtTable(debts),
      cashHandoverEvidence: { findUnique: vi.fn(async () => evidence) },
      rider: { findUnique: vi.fn(async () => ({ userId: 'u1' })) },
      driver: { findUnique: vi.fn(async () => null) },
      handoverPhotoProof: { findUnique: vi.fn(async () => proof(objectKey)) },
      orderStatusLog: { findUnique: vi.fn(async () => null) },
    });
    const heldRow = openEvidence();
    const held = await admittedHandoverEvidence(db(HELD, [heldRow]) as never, order, claim);
    expect(held).toMatchObject({ bound: true, photo: false });
    const released = await admittedHandoverEvidence(db(HELD, [{ ...heldRow, result: 'CLEAN', rescannedAt: new Date(), releasedAt: new Date(), releasedKey: '/uploads/handover-proof/o1/abc.jpg' }]) as never, order, claim);
    expect(released).toMatchObject({ bound: true, photo: true });
    const positive = await admittedHandoverEvidence(db(HELD, [{ ...heldRow, result: 'FOUND', fileKey: null }]) as never, order, claim);
    expect(positive).toMatchObject({ bound: true, photo: false });
    const scannedAtUpload = await admittedHandoverEvidence(db('/uploads/handover-proof/o1/zzz.jpg', []) as never, order, claim);
    expect(scannedAtUpload).toMatchObject({ bound: true, photo: true });
  });

  it('custody proceeds on a held photo: the delivery seam does not consult the scan (the scanner never blocks a delivery)', () => {
    const src = readFileSync(join(__dirname, '..', 'modules', 'cash', 'handover-evidence.ts'), 'utf8');
    const seam = src.slice(src.indexOf('export async function admittedCourierPhoto('));
    expect(seam).not.toMatch(/evidenceAdmissible|isQuarantineKey|isHeldKey/);
  });
});
