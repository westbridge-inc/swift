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
 *        (HELD) and ops are paged; a platform admin releases it after a manual check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../modules/ops/ops-page', () => ({
  pageOps: vi.fn(async () => ({ status: 'delivered', opsAlertId: 'a1', recipients: 1 })),
  resolveOpsPage: vi.fn(async () => 1),
}));

import { pageOps } from '../modules/ops/ops-page';
import { BYPASS_SURFACES, NEVER_REFUSED_SURFACES, scanUpload } from '../lib/malware-scan';
import { QUARANTINE_HELD_FOLDER, assertServableKey, heldFolder, isQuarantineKey, recordUnscannedUpload, releaseHeldUpload, rescanUploadDebt } from '../lib/upload-scan-debt';
import { EVIDENCE_HELD_PAGE_TITLE, watchMalwareScanner } from '../modules/ops/malware-scanner-watch';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';

const servers: net.Server[] = [];
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
  it('the route stores it in the held quarantine folder, and only then', () => {
    expect(heldFolder('QUARANTINE', 'handover-proof/o1')).toBe(`${QUARANTINE_HELD_FOLDER}/handover-proof/o1`);
    for (const outcome of ['CLEAN', 'SKIPPED', 'UNSCANNED'] as const) expect(heldFolder(outcome, 'handover-proof/o1')).toBe('handover-proof/o1');
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

  it('nothing serves a quarantined object: both storage adapters refuse to sign one', () => {
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

  it('a platform admin releases it after a manual check: once, and only a held row', async () => {
    const db = fakeDb();
    db.rows.push({ id: 'h1', result: 'HELD', releasedAt: null }, { id: 'h2', result: 'FOUND', releasedAt: null });
    await expect(releaseHeldUpload(db as never, 'h1')).resolves.toBe(true);
    expect(db.rows[0]!['releasedAt']).toBeInstanceOf(Date);
    await expect(releaseHeldUpload(db as never, 'h1')).resolves.toBe(false);
    await expect(releaseHeldUpload(db as never, 'h2')).resolves.toBe(false);
    expect(ADMIN_ROUTE_AUTHORITY['GET /upload-scan-debts/held']).toMatchObject({ cls: 'C1' });
    expect(ADMIN_ROUTE_AUTHORITY['POST /upload-scan-debts/:id/release']).toMatchObject({ cls: 'C3' });
    const routes = readFileSync(join(__dirname, '..', 'modules', 'admin', 'admin.routes.ts'), 'utf8');
    const handler = routes.slice(routes.indexOf("app.post('/upload-scan-debts/:id/release'"));
    expect(handler.slice(0, 900)).toMatch(/platformControlGuard/);
    expect(handler.slice(0, 1500)).toMatch(/auditIn\(tx, request\.user\.userId, 'RELEASE_HELD_UPLOAD'/);
  });

  it('evidence is never lost: the 30-day purge only ever takes the quarantined copies of bypass uploads', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { uploadScanDebt: { findMany, updateMany: vi.fn(), deleteMany: vi.fn(async () => ({ count: 0 })) }, encryptedObject: { findUnique: vi.fn() } };
    const env = await reachable('error-reply'); // answers PING: the pass runs
    await rescanUploadDebt({ prisma: prisma as never, redis: {} as never, notifications: {} as never, storage: { getObject: vi.fn(), upload: vi.fn(), delete: vi.fn() } as never, env });
    const purge = findMany.mock.calls.map(([args]) => (args as { where: Record<string, unknown> }).where).find((w) => 'quarantineKey' in w);
    expect(purge).toMatchObject({ reason: 'bypass' });
  });

  it('ops are paged while evidence is held and not released', async () => {
    const prisma = { uploadScanDebt: { count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (where['result'] === 'HELD' ? 2 : 0)) } };
    await watchMalwareScanner({ prisma: prisma as never, redis: { del: vi.fn(), incr: vi.fn(), expire: vi.fn() } as never, notifications: {} as never }, { MALWARE_SCAN: 'clamd' }, async () => ({ state: 'ok' }));
    const page = vi.mocked(pageOps).mock.calls.find(([, i]) => i.title === EVIDENCE_HELD_PAGE_TITLE);
    expect(page![1]).toMatchObject({ data: { kind: 'ops_evidence_held', held: 2 } });
  });
});
