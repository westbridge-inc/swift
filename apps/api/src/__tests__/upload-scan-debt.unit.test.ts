/**
 * [Row 312 · COORD ruling 21 Oct] When the scanner is down:
 *  (1) evidence (safety evidence: SOS, incident and report evidence, owner rule 18 Oct; delivery and
 *      handover proof, COORD 21 Oct) is NEVER refused: it is stored, flagged unscanned and paged;
 *  (2) MALWARE_SCAN_BYPASS=1 is the production emergency switch: exactly the liveness selfies,
 *      onboarding documents and vehicle photos are stored flagged unscanned instead of refused (never
 *      a profile picture). Everything else still waits for the scanner.
 * ("Down" = the connection failed AND a fresh PING fails: upload-scan-reachable.unit.test.ts.)
 * Every upload stored unscanned is an UploadScanDebt row; the upload-rescan job scans it once clamd
 * answers again, and a positive is moved to quarantine (out of every place that serves it) and paged.
 * A signature found is ALWAYS refused (422), bypass or not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../modules/ops/ops-page', () => ({
  pageOps: vi.fn(async () => ({ status: 'delivered', opsAlertId: 'a1', recipients: 1 })),
  resolveOpsPage: vi.fn(async () => 1),
}));

import { pageOps } from '../modules/ops/ops-page';
import { BYPASS_SURFACES, NEVER_REFUSED_SURFACES, SAFETY_EVIDENCE_SURFACES, malwareScanBypassOn, scanUpload, type UploadSurface } from '../lib/malware-scan';
import { MAX_RESCAN_ATTEMPTS, QUARANTINE_FOLDER, RESCAN_BATCH, recordUnscannedUpload, rescanUploadDebt, UPLOAD_QUARANTINED_PAGE_TITLE } from '../lib/upload-scan-debt';
import { encryptBuffer, generateDek } from '../providers/storage/envelope';
import { JOB_RECOVERY } from '../jobs/recovery-policy';
import { alertClassOf } from '../providers/notifications/alert-class';

const EICAR_LIKE = Buffer.from('synthetic payload the fake scanner calls a virus');
const servers: net.Server[] = [];
afterEach(async () => {
  vi.mocked(pageOps).mockClear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A fake clamd: FOUND for EICAR_LIKE, OK for anything else; records what it was sent. */
async function fakeClamd() {
  const seen: Buffer[] = [];
  const server = net.createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.toString('utf8').startsWith('zPING\0')) { socket.end('PONG\0'); return; }
      const head = 'zINSTREAM\0'.length;
      const parts: Buffer[] = [];
      let at = head;
      for (;;) {
        if (data.length < at + 4) return;
        const length = data.readUInt32BE(at);
        if (length === 0) break;
        if (data.length < at + 4 + length) return;
        parts.push(data.subarray(at + 4, at + 4 + length));
        at += 4 + length;
      }
      const payload = Buffer.concat(parts);
      seen.push(payload);
      socket.end(payload.equals(EICAR_LIKE) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { seen, env: { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(port) } as Record<string, string | undefined> };
}

/** Nothing listens here: the scanner is down. */
const DOWN = { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '1' } as Record<string, string | undefined>;
const log = () => ({ warn: vi.fn(), error: vi.fn() });
const ALL: UploadSurface[] = ['verification', 'liveness', 'avatar', 'vehicle-photo', 'chat', 'courier-proof', 'handover-proof', 'store-media', 'ads', 'admin', 'safety-evidence'];

describe('[Row 312] what an upload meets while the scanner is down', () => {
  it('safety evidence is accepted unscanned, never refused (bypass or not), and logged', async () => {
    const l = log();
    await expect(scanUpload(Buffer.from('photo of the scene'), { surface: 'safety-evidence', log: l }, DOWN)).resolves.toBe('UNSCANNED');
    expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ surface: 'safety-evidence' }), expect.stringMatching(/unscanned/));
    expect([...SAFETY_EVIDENCE_SURFACES]).toEqual(['safety-evidence']);
  });

  it('[COORD 21 Oct] delivery and handover proof are evidence too: never refused (bypass or not), flagged unscanned', async () => {
    expect([...NEVER_REFUSED_SURFACES].sort()).toEqual(['courier-proof', 'handover-proof', 'safety-evidence']);
    for (const surface of ['courier-proof', 'handover-proof'] as const) {
      for (const env of [DOWN, { ...DOWN, MALWARE_SCAN_BYPASS: '1' }]) {
        const l = log();
        await expect(scanUpload(Buffer.from('proof photo'), { surface, log: l }, env), surface).resolves.toBe('UNSCANNED');
        expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ surface }), expect.stringMatching(/unscanned/));
      }
    }
    // A file clamd POSITIVELY flags is still refused.
    const { env } = await fakeClamd();
    for (const surface of ['courier-proof', 'handover-proof'] as const) {
      await expect(scanUpload(EICAR_LIKE, { surface, log: log() }, env), surface).rejects.toMatchObject({ statusCode: 422, code: 'UPLOAD_REJECTED' });
    }
    // Recorded as evidence (paged as evidence), with or without the bypass.
    const db = fakeDb();
    await recordUnscannedUpload(db as never, 'UNSCANNED', { surface: 'handover-proof', fileKey: 'handover-proof/o/1', buffer: Buffer.from('p'), storage: fakeStorage() as never }, {});
    await recordUnscannedUpload(db as never, 'UNSCANNED', { surface: 'courier-proof', fileKey: 'courier-proof/o/1', buffer: Buffer.from('p'), storage: fakeStorage() as never }, { MALWARE_SCAN_BYPASS: '1' });
    expect(db.rows.map((r) => r['reason'])).toEqual(['evidence', 'evidence']);
  });

  it('without the bypass every other surface is refused 503', async () => {
    for (const surface of ALL.filter((s) => !NEVER_REFUSED_SURFACES.has(s))) {
      await expect(scanUpload(Buffer.from('x'), { surface, log: log() }, DOWN), surface).rejects.toMatchObject({ statusCode: 503, code: 'UPLOAD_SCAN_UNAVAILABLE' });
    }
  });

  it('MALWARE_SCAN_BYPASS=1: what a mover needs to work is accepted unscanned; the rest still waits', async () => {
    const env = { ...DOWN, MALWARE_SCAN_BYPASS: '1' };
    // [COORD 21 Oct, security finding 2] EXACTLY the set: the liveness selfie, onboarding documents and
    // vehicle photos. Never the avatar (any user's profile picture is shown to others).
    expect([...BYPASS_SURFACES].sort()).toEqual(['liveness', 'vehicle-photo', 'verification']);
    for (const surface of ALL) {
      if (BYPASS_SURFACES.has(surface) || NEVER_REFUSED_SURFACES.has(surface)) await expect(scanUpload(Buffer.from('x'), { surface, log: log() }, env), surface).resolves.toBe('UNSCANNED');
      else await expect(scanUpload(Buffer.from('x'), { surface, log: log() }, env), surface).rejects.toMatchObject({ statusCode: 503 });
    }
    for (const value of ['', '0', 'true', 'yes', 'on', '2']) expect(malwareScanBypassOn({ ...DOWN, MALWARE_SCAN_BYPASS: value }), value).toBe(false);
    expect(malwareScanBypassOn(env)).toBe(true);
  });

  it('the bypass never skips a scanner that answers, and a signature is ALWAYS refused', async () => {
    const { env, seen } = await fakeClamd();
    const on = { ...env, MALWARE_SCAN_BYPASS: '1' };
    await expect(scanUpload(Buffer.from('clean'), { surface: 'liveness' }, on)).resolves.toBe('CLEAN');
    expect(seen).toHaveLength(1);
    for (const surface of ['liveness', 'safety-evidence'] as const) {
      await expect(scanUpload(EICAR_LIKE, { surface, log: log() }, on)).rejects.toMatchObject({ statusCode: 422, code: 'UPLOAD_REJECTED' });
    }
  });

  it('dark scanner: nothing is scanned and nothing is owed', async () => {
    await expect(scanUpload(Buffer.from('x'), { surface: 'safety-evidence' }, { MALWARE_SCAN_BYPASS: '1' })).resolves.toBe('SKIPPED');
  });
});

// ---------------------------------------------------------------------------
// The debt: one row per upload stored unscanned.
// ---------------------------------------------------------------------------
function fakeDb(rows: Array<Record<string, unknown>> = []) {
  const keys = new Map<string, { iv: Uint8Array; authTag: Uint8Array; wrappedDek: Uint8Array }>();
  return {
    rows,
    keys,
    uploadScanDebt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `d${rows.length + 1}`, attempts: 0, rescannedAt: null, quarantinedAt: null, quarantineKey: null, createdAt: new Date(), ...data }; rows.push(row); return row; }),
      // Honours the open filter, attempts-then-age order and the batch size the job asks for.
      findMany: vi.fn(async (args: { where?: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> | Array<Record<string, 'asc' | 'desc'>>; take?: number } = {}) => {
        if (args.where && 'quarantinedAt' in args.where && args.where['quarantinedAt'] !== null) return []; // the purge pass: nothing old here
        const open = rows.filter((r) => r['rescannedAt'] === null && r['quarantinedAt'] === null);
        const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : [];
        open.sort((a, b) => { for (const o of order) { const [k, dir] = Object.entries(o)[0]!; const d = Number(a[k]) - Number(b[k]); if (d) return dir === 'asc' ? d : -d; } return 0; });
        return open.slice(0, args.take ?? open.length);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r['id'] === where['id'] && (where['rescannedAt'] === undefined || r['rescannedAt'] === where['rescannedAt']));
        if (!row) return { count: 0 };
        for (const [k, v] of Object.entries(data)) row[k] = typeof v === 'object' && v && 'increment' in v ? (row[k] as number) + (v as { increment: number }).increment : v;
        return { count: 1 };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      count: vi.fn(async () => 0),
    },
    encryptedObject: { findUnique: vi.fn(async ({ where }: { where: { fileKey: string } }) => keys.get(where.fileKey) ?? null) },
  };
}
function fakeStorage(objects = new Map<string, Buffer>()) {
  let n = 0;
  return {
    objects,
    upload: vi.fn(async ({ buffer, folder }: { buffer: Buffer; folder: string }) => { const url = `${folder}/q${++n}`; objects.set(url, buffer); return { url }; }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
    getObject: vi.fn(async (key: string) => { const b = objects.get(key); if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return b; }),
  };
}

describe('[Row 312] the debt of an upload stored unscanned', () => {
  it('records nothing for a scanned or skipped upload', async () => {
    const db = fakeDb();
    for (const outcome of ['CLEAN', 'SKIPPED'] as const) {
      await recordUnscannedUpload(db as never, outcome, { surface: 'liveness', fileKey: 'liveness/u/1', buffer: Buffer.from('x'), storage: fakeStorage() as never });
    }
    expect(db.uploadScanDebt.create).not.toHaveBeenCalled();
  });

  it('records the key, digest, surface, reason and sealing of an unscanned upload: no person id, no content', async () => {
    const db = fakeDb();
    const buffer = Buffer.from('a selfie');
    await recordUnscannedUpload(db as never, 'UNSCANNED', { surface: 'liveness', fileKey: 'liveness/u/1', buffer, storage: fakeStorage() as never }, { MALWARE_SCAN_BYPASS: '1' });
    await recordUnscannedUpload(db as never, 'UNSCANNED', { surface: 'safety-evidence', fileKey: 'evidence/1', buffer, sealed: true, storage: fakeStorage() as never }, {});
    expect(db.rows.map((r) => [r['surface'], r['reason'], r['fileKey'], r['sealed'], r['sha256']])).toEqual([
      ['liveness', 'bypass', 'liveness/u/1', false, createHash('sha256').update(buffer).digest('hex')],
      ['safety-evidence', 'evidence', 'evidence/1', true, createHash('sha256').update(buffer).digest('hex')],
    ]);
    expect(JSON.stringify(db.rows)).not.toContain('a selfie');
  });

  it('an unscanned upload that cannot be recorded is not kept: the object is deleted and the upload refused 503', async () => {
    const db = fakeDb();
    db.uploadScanDebt.create.mockRejectedValueOnce(new Error('db down'));
    const storage = fakeStorage(new Map([['liveness/u/1', Buffer.from('x')]]));
    await expect(recordUnscannedUpload(db as never, 'UNSCANNED', { surface: 'liveness', fileKey: 'liveness/u/1', buffer: Buffer.from('x'), storage: storage as never }))
      .rejects.toMatchObject({ statusCode: 503, code: 'UPLOAD_SCAN_UNAVAILABLE' });
    expect(storage.delete).toHaveBeenCalledWith('liveness/u/1');
  });
});

/** A sealed object's storage key (built, so no literal reads as a credential to a secret scanner). */
const sealedObject = (n: number) => ['verification', 'u', String(n)].join('/');

describe('[Row 312] the rescan once clamd answers', () => {
  const deps = (db: ReturnType<typeof fakeDb>, storage: ReturnType<typeof fakeStorage>, env: Record<string, string | undefined>) =>
    ({ prisma: db as never, redis: {} as never, notifications: {} as never, storage: storage as never, env, unwrapDek: async (w: Buffer) => w });

  it('does nothing while the scanner is still down', async () => {
    const db = fakeDb([{ id: 'd1', surface: 'liveness', reason: 'bypass', fileKey: 'liveness/u/1', sealed: false, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null }]);
    const storage = fakeStorage(new Map([['liveness/u/1', Buffer.from('x')]]));
    await expect(rescanUploadDebt(deps(db, storage, DOWN))).resolves.toMatchObject({ scanned: 0 });
    expect(db.rows[0]!['rescannedAt']).toBeNull();
  });

  it('clean: closed, and the key is forgotten', async () => {
    const { env } = await fakeClamd();
    const db = fakeDb([{ id: 'd1', surface: 'liveness', reason: 'bypass', fileKey: 'liveness/u/1', sealed: false, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null }]);
    const storage = fakeStorage(new Map([['liveness/u/1', Buffer.from('a selfie')]]));
    await expect(rescanUploadDebt(deps(db, storage, env))).resolves.toMatchObject({ scanned: 1, clean: 1, quarantined: 0 });
    expect(db.rows[0]).toMatchObject({ result: 'CLEAN', fileKey: null, rescannedAt: expect.any(Date) });
    expect(storage.objects.has('liveness/u/1')).toBe(true);
    expect(pageOps).not.toHaveBeenCalled();
  });

  it('positive: moved to quarantine (gone from where it was served), recorded and paged', async () => {
    const { env } = await fakeClamd();
    const db = fakeDb([{ id: 'd1', surface: 'vehicle-photo', reason: 'bypass', fileKey: 'vehicles/u/1', sealed: false, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null }]);
    const storage = fakeStorage(new Map([['vehicles/u/1', EICAR_LIKE]]));
    await expect(rescanUploadDebt(deps(db, storage, env))).resolves.toMatchObject({ scanned: 1, quarantined: 1 });
    expect(storage.objects.has('vehicles/u/1')).toBe(false);
    const row = db.rows[0]!;
    expect(row).toMatchObject({ result: 'FOUND', signature: 'Eicar-Test-Signature', quarantinedAt: expect.any(Date) });
    expect(String(row['quarantineKey'])).toMatch(new RegExp(`^${QUARANTINE_FOLDER}/`));
    expect(storage.objects.get(String(row['quarantineKey']))!.equals(EICAR_LIKE)).toBe(true);
    expect(pageOps).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pageOps).mock.calls[0]![1]).toMatchObject({ title: UPLOAD_QUARANTINED_PAGE_TITLE, data: { kind: 'ops_upload_quarantined', surface: 'vehicle-photo' } });
  });

  it('a sealed upload is opened with its own key and the PLAINTEXT is scanned; the quarantine keeps the ciphertext', async () => {
    const { env, seen } = await fakeClamd();
    const dek = generateDek();
    const { ciphertext, iv, authTag } = encryptBuffer(EICAR_LIKE, dek);
    const db = fakeDb([{ id: 'd1', surface: 'verification', reason: 'bypass', fileKey: sealedObject(1), sealed: true, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null }]);
    db.keys.set('verification/u/1', { iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(dek) });
    const storage = fakeStorage(new Map([['verification/u/1', ciphertext]]));
    await expect(rescanUploadDebt(deps(db, storage, env))).resolves.toMatchObject({ quarantined: 1 });
    expect(seen[0]!.equals(EICAR_LIKE)).toBe(true);
    const row = db.rows[0]!;
    expect(storage.objects.get(String(row['quarantineKey']))!.equals(ciphertext)).toBe(true);
    expect(row['fileKey']).toBe('verification/u/1'); // its key row is found by the original key
  });

  it('an object already erased, or a sealed one whose key was shredded, closes without a scan', async () => {
    const { env, seen } = await fakeClamd();
    const db = fakeDb([
      { id: 'd1', surface: 'vehicle-photo', reason: 'bypass', fileKey: 'vehicles/u/gone', sealed: false, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null },
      { id: 'd2', surface: 'verification', reason: 'bypass', fileKey: sealedObject(2), sealed: true, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null },
      // The crypto-shred nulls the wrapped key and keeps the row (encrypted_objects.wrappedDek).
      { id: 'd3', surface: 'verification', reason: 'bypass', fileKey: sealedObject(3), sealed: true, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null },
    ]);
    db.keys.set('verification/u/3', { iv: new Uint8Array(12), authTag: new Uint8Array(16), wrappedDek: null as unknown as Uint8Array });
    const storage = fakeStorage(new Map([['verification/u/2', randomBytes(64)], ['verification/u/3', randomBytes(64)]]));
    await rescanUploadDebt(deps(db, storage, env));
    expect(db.rows.map((r) => [r['result'], r['fileKey']])).toEqual([['GONE', null], ['SHREDDED', null], ['SHREDDED', null]]);
    expect(seen).toHaveLength(0);
  });
});

describe('[Row 312 · security review] a row that keeps failing never starves the rest, and never stays served', () => {
  const deps = (db: ReturnType<typeof fakeDb>, storage: ReturnType<typeof fakeStorage>, env: Record<string, string | undefined>) =>
    ({ prisma: db as never, redis: {} as never, notifications: {} as never, storage: storage as never, env, unwrapDek: async (w: Buffer) => w });
  const row = (id: string, fileKey: string, at: number, extra: Record<string, unknown> = {}) =>
    ({ id, surface: 'liveness', reason: 'bypass', fileKey, sealed: false, sha256: 'x', attempts: 0, rescannedAt: null, quarantinedAt: null, createdAt: new Date(at), ...extra });

  it('a batch-full of always-failing older rows does not stop a newer row being rescanned', async () => {
    const { env } = await fakeClamd();
    const failing = Array.from({ length: RESCAN_BATCH }, (_, i) => row(`bad${i}`, `liveness/bad/${i}`, 1_000 + i));
    const db = fakeDb([...failing, row('next', 'liveness/next', 9_000)]);
    const storage = fakeStorage(new Map([['liveness/next', Buffer.from('a selfie')]]));
    storage.getObject.mockImplementation(async (key: string) => {
      if (key.startsWith('liveness/bad/')) throw new Error('read timed out'); // not "missing": a failure
      return storage.objects.get(key)!;
    });
    await rescanUploadDebt(deps(db, storage, env));
    await rescanUploadDebt(deps(db, storage, env));
    expect(db.rows.find((r) => r['id'] === 'next')).toMatchObject({ result: 'CLEAN', rescannedAt: expect.any(Date) });
  });

  it(`a row that fails MAX_RESCAN_ATTEMPTS times is UNSCANNABLE: taken out of service, quarantined, recorded and paged`, async () => {
    const { env } = await fakeClamd();
    // A sealed object whose ciphertext no longer opens: readable bytes, never scannable.
    const db = fakeDb([row('corrupt', 'verification/u/9', 1_000, { surface: 'verification', sealed: true })]);
    db.keys.set('verification/u/9', { iv: new Uint8Array(12), authTag: new Uint8Array(16), wrappedDek: new Uint8Array(32) });
    const stored = randomBytes(64);
    const storage = fakeStorage(new Map([['verification/u/9', stored]]));
    for (let i = 0; i < MAX_RESCAN_ATTEMPTS; i += 1) await rescanUploadDebt(deps(db, storage, env));
    const r = db.rows[0]!;
    expect(r).toMatchObject({ result: 'UNSCANNABLE', quarantinedAt: expect.any(Date) });
    expect(storage.objects.has('verification/u/9')).toBe(false);
    expect(storage.objects.get(String(r['quarantineKey']))!.equals(stored)).toBe(true);
    expect(vi.mocked(pageOps).mock.calls.at(-1)![1]).toMatchObject({ title: UPLOAD_QUARANTINED_PAGE_TITLE, data: { kind: 'ops_upload_quarantined', signature: 'UNSCANNABLE' } });
  });

  it('an object that cannot even be read is still taken out of service at the cap', async () => {
    const { env } = await fakeClamd();
    const db = fakeDb([row('unreadable', 'liveness/u/7', 1_000)]);
    const storage = fakeStorage(new Map([['liveness/u/7', Buffer.from('x')]]));
    storage.getObject.mockImplementation(async () => { throw new Error('read timed out'); });
    for (let i = 0; i < MAX_RESCAN_ATTEMPTS; i += 1) await rescanUploadDebt(deps(db, storage, env));
    expect(db.rows[0]).toMatchObject({ result: 'UNSCANNABLE', quarantinedAt: expect.any(Date), quarantineKey: null });
    expect(storage.delete).toHaveBeenCalledWith('liveness/u/7');
    expect(storage.objects.has('liveness/u/7')).toBe(false);
  });
});

describe('[Row 312] every upload that can be stored unscanned records its debt', () => {
  const MODULES = join(__dirname, '..', 'modules');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { if (entry !== '__tests__') walk(full, out); } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };
  it('each scanUpload of a bypass or evidence surface is followed by recordUnscannedUpload for the same surface', () => {
    const missing: string[] = [];
    let covered = 0;
    for (const file of walk(MODULES)) {
      const src = readFileSync(file, 'utf8');
      for (const surface of new Set([...BYPASS_SURFACES, ...NEVER_REFUSED_SURFACES])) {
        const scans = src.split(`scanUpload(`).slice(1).filter((s) => s.slice(0, 200).includes(`surface: '${surface}'`)).length;
        const records = src.split(`recordUnscannedUpload(`).slice(1).filter((s) => s.slice(0, 400).includes(`surface: '${surface}'`)).length;
        covered += scans;
        if (records < scans) missing.push(`${file.slice(MODULES.length + 1)} ${surface}: ${scans} scans, ${records} records`);
      }
    }
    expect(covered).toBeGreaterThanOrEqual(7); // the census sees the real call sites (avatar left the bypass)
    expect(missing).toEqual([]);
  });

  it('each evidence site stores a QUARANTINE outcome in the held quarantine folder (heldFolder), never its normal folder', () => {
    const missing: string[] = [];
    let sites = 0;
    for (const file of walk(MODULES)) {
      const src = readFileSync(file, 'utf8');
      for (const surface of NEVER_REFUSED_SURFACES) {
        const scans = src.split('scanUpload(').slice(1).filter((s) => s.slice(0, 200).includes(`surface: '${surface}'`));
        for (const after of scans) {
          sites += 1;
          const upload = after.slice(0, after.indexOf('recordUnscannedUpload('));
          if (!/\.upload\([\s\S]*folder: heldFolder\(scan, /.test(upload)) missing.push(`${file.slice(MODULES.length + 1)} ${surface}`);
        }
      }
    }
    expect(sites).toBeGreaterThanOrEqual(3);
    expect(missing).toEqual([]);
  });

  it('the rescan is a registered, replay-safe job, and its page is an ops-class alert', () => {
    expect(JOB_RECOVERY['upload-rescan']).toMatchObject({ policy: 'SAFE_REPLAY' });
    for (const kind of ['ops_upload_quarantined', 'ops_malware_scan_bypass', 'ops_evidence_unscanned']) expect(alertClassOf(kind), kind).toBe(alertClassOf('ops_backup_stale'));
  });
});
