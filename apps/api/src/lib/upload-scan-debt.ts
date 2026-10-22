/**
 * [Row 312 · COORD rulings 21-22 Oct] The debt of an upload stored WITHOUT a malware scan.
 *
 * Two kinds of upload are stored before a clean scan, each recorded here right after it is stored (one
 * upload_scan_debts row: the object key, the file's sha256, its surface, why, and whether the stored
 * bytes are sealed; no person or tenant id and never the content). A row that cannot be written means
 * the upload is not kept: the object is deleted and the upload refused (503), so nothing unscanned is
 * ever stored untracked.
 *  - BYPASS (MALWARE_SCAN_BYPASS=1, scanner unreachable): the liveness selfie, onboarding documents and
 *    vehicle photos, stored in their normal folder;
 *  - EVIDENCE (safety evidence, delivery and handover proof), never refused: stored ONLY in the held
 *    quarantine folder (heldFolder; recordUnscannedUpload refuses any other key). Nothing serves a
 *    quarantine key (both storage adapters refuse to sign one) and no claim admits it as proof
 *    (evidenceAdmissible) until a scan answers CLEAN. Scanner unreachable -> an open row, rescanned;
 *    scanner up but failing on the file -> HELD at once (never retried on its own: a file that crashes
 *    the scanner must not crash it again every pass), paged until a platform admin retries its scan.
 *
 * The upload-rescan job (rescanUploadDebt) scans each open row once clamd answers again: the stored
 * bytes (a sealed object opened with its own key, so the PLAINTEXT is scanned, as at upload).
 *  - clean -> closed; a bypass row forgets its key; held evidence is RELEASED: its bytes move to their
 *    normal folder (releaseHeldEvidence) and the row keeps the issued key beside the released one,
 *    because every record keeps the key it was issued (handover_photo_proofs is immutable provenance
 *    by a database trigger) and resolves it here (evidenceObjectKey);
 *  - a signature -> the stored bytes (still ciphertext if sealed) are moved to the quarantine folder,
 *    the original is deleted (so nothing serves it any more), the row records the signature, and ops
 *    are paged. A quarantined copy is purged after QUARANTINE_DAYS;
 *  - the object already erased, or a sealed one whose key was shredded -> closed without a scan;
 *  - a rescan that keeps failing (unreadable object, bytes that no longer open, a scanner error):
 *    after MAX_RESCAN_ATTEMPTS a bypass row is UNSCANNABLE and treated exactly like a positive
 *    (quarantined, the original deleted, recorded, paged), never left served and open; held evidence
 *    becomes HELD (kept where it is, never served, never admitted, paged). Rows are taken fewest
 *    attempts first, so failing rows can never fill every batch and starve newer uploads.
 * Closed bypass rows are deleted after CLOSED_ROW_DAYS; quarantine rows and evidence rows stay as the
 * record (an evidence row maps the issued key to where its bytes live).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError } from '../utils/errors';
import { isQuarantineKey } from '../providers/storage/quarantine-key';
import type { NotificationService } from '../modules/notification/notification.service';
import { pageOps } from '../modules/ops/ops-page';
import { decryptBuffer, getKeyProvider } from '../providers/storage/envelope';
import type { StorageProvider } from '../providers/storage/storage-provider';
import {
  clamdInstream, malwareScanBypassOn, malwareScannerStatus, noteScanPayloadFailure, privateScannerAddress, CLAMD_DEFAULT_PORT,
  NEVER_REFUSED_SURFACES, type ScanOutcome, type ScanVerdict, type UploadSurface,
} from './malware-scan';

export const QUARANTINE_FOLDER = 'quarantine/uploads';
/** Evidence stored before a clean scan lives here (never served, never admitted) until it is released. */
export const QUARANTINE_HELD_FOLDER = 'quarantine/held';

/** EVIDENCE routes only (census: upload-scan-debt.unit.test.ts): the folder an evidence upload is
 *  stored in. Anything not scanned CLEAN ('UNSCANNED': scanner unreachable; 'QUARANTINE': scanner up
 *  but failing on the file) goes into the held quarantine folder, never its normal folder. */
export function heldFolder(outcome: ScanOutcome, folder: string): string {
  return outcome === 'UNSCANNED' || outcome === 'QUARANTINE' ? `${QUARANTINE_HELD_FOLDER}/${folder}` : folder;
}

export { assertServableKey, isQuarantineKey } from '../providers/storage/quarantine-key';

/** The key's path inside the bucket (a local key is "/uploads/<path>"). */
function storedPath(fileKey: string): string {
  return fileKey.startsWith('/uploads/') ? fileKey.slice('/uploads/'.length) : fileKey;
}
/** Is this key in the held quarantine folder? */
export function isHeldKey(fileKey: string): boolean {
  return storedPath(fileKey).startsWith(`${QUARANTINE_HELD_FOLDER}/`);
}

const IMAGE_TYPES: Readonly<Record<string, string>> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * [COORD 22 Oct] Held evidence that scanned CLEAN leaves the quarantine: its bytes are stored again in
 * their normal folder (the held path without the quarantine prefix) and the row records where
 * (releasedKey) in the same compare-and-set that closes it; the held copy is deleted only after that
 * row is written. Every record keeps the key it was issued and resolves it with evidenceObjectKey.
 * Returns the released key, or null when another pass got there first (its copy is removed).
 */
export async function releaseHeldEvidence(
  deps: { prisma: DebtDb & Partial<Pick<PrismaClient, '$transaction'>>; storage: Pick<StorageProvider, 'getObject' | 'upload' | 'delete'> },
  row: { id: string; fileKey: string | null },
  close: Record<string, unknown>,
  now = new Date(),
  trail?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<string | null> {
  const heldKey = row.fileKey;
  if (!heldKey || !isHeldKey(heldKey)) throw new Error('not held evidence');
  const released = await promoteHeldBytes(deps.storage, heldKey);
  let won: boolean;
  try {
    const write = (db: DebtDb) => db.uploadScanDebt.updateMany({ where: { id: row.id, releasedAt: null, rescannedAt: null }, data: { ...close, releasedAt: now, releasedKey: released } });
    if (trail) {
      if (!deps.prisma.$transaction) throw new Error('a release with an audit trail needs a transaction');
      // The release and its trail commit together; a lost race writes no trail.
      won = await deps.prisma.$transaction(async (tx) => {
        const r = await write(tx);
        if (r.count === 1) await trail(tx);
        return r.count === 1;
      });
    } else {
      won = (await write(deps.prisma)).count === 1;
    }
  } catch (error) {
    await deps.storage.delete(released).catch(() => undefined);
    throw error;
  }
  if (!won) {
    await deps.storage.delete(released).catch(() => undefined);
    return null;
  }
  await deps.storage.delete(heldKey).catch(() => undefined);
  return released;
}

/** Copy held bytes to their normal folder (the held path without its quarantine prefix): the new key. */
export async function promoteHeldBytes(storage: Pick<StorageProvider, 'getObject' | 'upload'>, heldKey: string): Promise<string> {
  const inner = storedPath(heldKey).slice(`${QUARANTINE_HELD_FOLDER}/`.length);
  const folder = path.posix.dirname(inner);
  const filename = path.posix.basename(inner);
  if (!folder || folder === '.' || !filename) throw new Error('a held key without a folder');
  const buffer = await storage.getObject(heldKey);
  const { url } = await storage.upload({ buffer, filename, folder, mimeType: IMAGE_TYPES[path.posix.extname(filename).toLowerCase()] ?? 'application/octet-stream' });
  return url;
}

/**
 * [COORD 22 Oct] Is this stored evidence key admissible as proof (a claim, a dispute)? A key outside the
 * quarantine was scanned clean at upload. A held key only once a clean scan released it. Held,
 * quarantined, positive or unknown: never.
 */
export async function evidenceAdmissible(prisma: DebtDb, fileKey: string | null | undefined): Promise<boolean> {
  if (!fileKey) return false;
  if (!isQuarantineKey(fileKey)) return true;
  return (await evidenceObjectKey(prisma, fileKey)) !== null;
}

/** Where an evidence key's bytes live now: the key itself outside the quarantine, the released key for
 *  held evidence that scanned clean, null while it is held (or was quarantined). */
export async function evidenceObjectKey(prisma: DebtDb, fileKey: string): Promise<string | null> {
  if (!isQuarantineKey(fileKey)) return fileKey;
  const row = await prisma.uploadScanDebt.findFirst({
    where: { fileKey, reason: 'evidence', result: 'CLEAN', releasedAt: { not: null }, releasedKey: { not: null } },
    select: { releasedKey: true },
  });
  return row?.releasedKey ?? null;
}
export const QUARANTINE_DAYS = 30;
export const CLOSED_ROW_DAYS = 30;
export const RESCAN_BATCH = 25;
/** [Security review] Failed rescans before a row is UNSCANNABLE: taken out of service like a positive. */
export const MAX_RESCAN_ATTEMPTS = 5;
export const UPLOAD_QUARANTINED_PAGE_TITLE = 'An upload stored unscanned was quarantined (malware or unscannable)';
export const UPLOAD_UNSCANNABLE_SERVED_PAGE_TITLE = 'An unscannable upload could not be taken out of service';

type Env = Readonly<Record<string, string | undefined>>;
type DebtDb = Pick<PrismaClient, 'uploadScanDebt'>;

/** Call right after storing an upload whose scan outcome is `outcome`. A no-op for 'CLEAN' / 'SKIPPED'. */
export async function recordUnscannedUpload(
  prisma: DebtDb,
  outcome: ScanOutcome,
  input: { surface: UploadSurface; fileKey: string; buffer: Buffer; sealed?: boolean; storage: Pick<StorageProvider, 'delete'> },
  env: Env = process.env,
): Promise<void> {
  if (outcome !== 'UNSCANNED' && outcome !== 'QUARANTINE') return;
  const evidence = NEVER_REFUSED_SURFACES.has(input.surface);
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  try {
    // [COORD 22 Oct] Evidence stored anywhere but the held quarantine folder is never kept (a route that
    // forgot heldFolder): nothing unscanned is ever servable or admissible as evidence.
    if (evidence && !isHeldKey(input.fileKey)) throw new Error('evidence stored outside the held quarantine folder');
    if (!evidence && (outcome !== 'UNSCANNED' || !malwareScanBypassOn(env))) throw new Error('only evidence or the bypass is stored unscanned');
    await prisma.uploadScanDebt.create({
      data: outcome === 'QUARANTINE'
        // Held: the scanner was up but failed on this file. In the quarantine folder (the route stored it
        // there); never served, never admitted, not rescanned on its own; paged until a platform admin
        // retries its scan (POST /admin/upload-scan-debts/:id/release) and it answers CLEAN.
        ? { surface: input.surface, reason: 'evidence', fileKey: input.fileKey, sealed: input.sealed === true, sha256, result: 'HELD', quarantinedAt: new Date(), quarantineKey: input.fileKey }
        : { surface: input.surface, reason: evidence ? 'evidence' : 'bypass', fileKey: input.fileKey, sealed: input.sealed === true, sha256 },
    });
  } catch {
    // Never keep an unscanned file nobody will rescan.
    await input.storage.delete(input.fileKey).catch(() => undefined);
    throw new AppError(503, 'UPLOAD_SCAN_UNAVAILABLE', 'Uploads are paused for a moment. Please try again shortly.');
  }
}

type RescanDeps = {
  prisma: Pick<PrismaClient, 'uploadScanDebt' | 'encryptedObject'>;
  redis: Redis;
  notifications: NotificationService;
  storage: Pick<StorageProvider, 'getObject' | 'upload' | 'delete'>;
  env?: Env;
  /** The sealed objects' key opener (tests inject one); default: the deployment's key provider. */
  unwrapDek?: (wrapped: Buffer) => Promise<Buffer>;
  now?: Date;
};

export type RescanResult = { scanned: number; clean: number; quarantined: number; closedWithoutScan: number; failed: number };

/** One pass of the upload-rescan job. Does nothing while the scanner does not answer. */
export async function rescanUploadDebt(deps: RescanDeps): Promise<RescanResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const result: RescanResult = { scanned: 0, clean: 0, quarantined: 0, closedWithoutScan: 0, failed: 0 };
  const status = await malwareScannerStatus(env);
  if (status.state !== 'ok') return result;
  const host = await privateScannerAddress(env['CLAMD_HOST']!.trim());
  const port = Number(env['CLAMD_PORT'] ?? CLAMD_DEFAULT_PORT);
  const open = await deps.prisma.uploadScanDebt.findMany({
    where: { rescannedAt: null, quarantinedAt: null, fileKey: { not: null } },
    orderBy: [{ attempts: 'asc' }, { createdAt: 'asc' }],
    take: RESCAN_BATCH,
  });
  const close = (id: string, data: Record<string, unknown>) =>
    deps.prisma.uploadScanDebt.updateMany({ where: { id, rescannedAt: null }, data: { rescannedAt: now, ...data } });
  const quarantine = (row: (typeof open)[number], stored: Buffer | null, signature: string, attempts?: number) =>
    quarantineDebt(deps, row, stored, signature, now, attempts);
  for (const row of open) {
    const fileKey = row.fileKey!;
    try {
      let stored: Buffer;
      try {
        stored = await deps.storage.getObject(fileKey);
      } catch (error) {
        if (!isMissingObject(error)) throw error;
        await close(row.id, { result: 'GONE', fileKey: null });
        result.closedWithoutScan += 1;
        continue;
      }
      let plaintext = stored;
      if (row.sealed) {
        const key = await deps.prisma.encryptedObject.findUnique({ where: { fileKey }, select: { iv: true, authTag: true, wrappedDek: true } });
        if (!key || !key.wrappedDek) {
          // No key row, or the crypto-shred nulled its wrapped key: nothing can open it, nothing serves it.
          await close(row.id, { result: 'SHREDDED', fileKey: null });
          result.closedWithoutScan += 1;
          continue;
        }
        const unwrap = deps.unwrapDek ?? defaultUnwrap();
        const dek = await unwrap(Buffer.from(key.wrappedDek));
        plaintext = decryptBuffer(stored, dek, Buffer.from(key.iv), Buffer.from(key.authTag));
      }
      const verdict = await clamdInstream(plaintext, { host, port });
      result.scanned += 1;
      if (verdict.result === 'CLEAN') {
        if (row.reason === 'evidence' && isHeldKey(fileKey)) {
          // [COORD 22 Oct] Held evidence leaves the quarantine only now: moved to its normal folder; the
          // row keeps the issued key beside the released one (every record resolves it here).
          await releaseHeldEvidence({ prisma: deps.prisma, storage: deps.storage }, row, { rescannedAt: now, result: 'CLEAN' }, now);
        } else {
          await close(row.id, { result: 'CLEAN', fileKey: null });
        }
        result.clean += 1;
        continue;
      }
      await quarantine(row, stored, verdict.signature);
      result.quarantined += 1;
    } catch (error) {
      result.failed += 1;
      // [COORD 22 Oct] A stored file that fails the scanner mid-scan starts the payload-failure cool-down too.
      if ((error as { phase?: string }).phase === 'scan') await noteScanPayloadFailure().catch(() => undefined);
      const attempts = row.attempts + 1;
      if (attempts < MAX_RESCAN_ATTEMPTS) {
        await deps.prisma.uploadScanDebt.updateMany({ where: { id: row.id, rescannedAt: null }, data: { attempts: { increment: 1 } } }).catch(() => undefined);
        continue;
      }
      if (row.reason === 'evidence' && isHeldKey(fileKey)) {
        // [COORD 22 Oct] Evidence is never lost: it stays HELD where it is (in the quarantine: never
        // served, never admitted), paged by the scanner watch until a platform admin retries its scan.
        await deps.prisma.uploadScanDebt.updateMany({ where: { id: row.id, rescannedAt: null }, data: { result: 'HELD', quarantinedAt: now, quarantineKey: fileKey, attempts } }).catch(() => undefined);
        continue;
      }
      // UNSCANNABLE: out of service like a positive. Copy the stored bytes if they can still be read.
      const readable = await deps.storage.getObject(fileKey).catch(() => null);
      try {
        await quarantine(row, readable, 'UNSCANNABLE', attempts);
        result.quarantined += 1;
      } catch {
        // Could not even take it out of service: keep trying every pass, and say so loudly.
        await deps.prisma.uploadScanDebt.updateMany({ where: { id: row.id, rescannedAt: null }, data: { attempts: { increment: 1 } } }).catch(() => undefined);
        await pageOps({ prisma: deps.prisma as PrismaClient, redis: deps.redis, notifications: deps.notifications }, {
          key: 'ops_page:upload-unscannable-served',
          windowSeconds: 3600,
          title: UPLOAD_UNSCANNABLE_SERVED_PAGE_TITLE,
          body: `An upload stored without a scan (${row.surface}, ${row.reason}) could not be rescanned and could not be taken out of service; delete it by hand (upload_scan_debts ${row.id}).`,
          data: { kind: 'ops_upload_quarantined', surface: row.surface, reason: row.reason, debtId: row.id, signature: 'UNSCANNABLE' },
        }).catch(() => undefined);
      }
    }
  }
  await purgeOldDebt(deps, now);
  return result;
}

/** Out of service: the bytes AS STORED (a sealed one stays ciphertext; its key row is found by the
 *  original key) to the quarantine folder when they can be read, the original deleted, recorded, paged. */
async function quarantineDebt(
  deps: RescanDeps,
  row: { id: string; surface: string; reason: string; fileKey: string | null; sealed: boolean },
  stored: Buffer | null,
  signature: string,
  now: Date,
  attempts?: number,
): Promise<void> {
  const fileKey = row.fileKey!;
  const quarantineKey = stored
    ? (await deps.storage.upload({ buffer: stored, filename: 'quarantined.bin', mimeType: 'application/octet-stream', folder: `${QUARANTINE_FOLDER}/${row.id}` })).url
    : null;
  await deps.storage.delete(fileKey);
  const result = signature === 'UNSCANNABLE' ? 'UNSCANNABLE' : 'FOUND';
  await deps.prisma.uploadScanDebt.updateMany({
    where: { id: row.id, rescannedAt: null },
    data: { rescannedAt: now, result, signature: signature.slice(0, 200), quarantinedAt: now, quarantineKey, fileKey: row.sealed ? fileKey : null, ...(attempts ? { attempts } : {}) },
  });
  await pageOps({ prisma: deps.prisma as PrismaClient, redis: deps.redis, notifications: deps.notifications }, {
    key: 'ops_page:upload-quarantined',
    windowSeconds: 3600,
    title: UPLOAD_QUARANTINED_PAGE_TITLE,
    body: result === 'FOUND'
      ? `An upload stored without a scan (${row.surface}, ${row.reason}) matched ${signature.slice(0, 120)}. It was moved to quarantine and no longer serves; check what used it (upload_scan_debts ${row.id}).`
      : `An upload stored without a scan (${row.surface}, ${row.reason}) could not be rescanned after ${MAX_RESCAN_ATTEMPTS} tries, so it was taken out of service${stored ? ' and moved to quarantine' : ' (its bytes could not be read)'}; check what used it (upload_scan_debts ${row.id}).`,
    data: { kind: 'ops_upload_quarantined', surface: row.surface, reason: row.reason, debtId: row.id, signature: signature.slice(0, 200) },
  });
}

export type HeldRetry =
  | { outcome: 'RELEASED'; releasedKey: string }
  | { outcome: 'FOUND'; signature: string }
  | { outcome: 'STILL_HELD'; why: string }
  | { outcome: 'NOT_HELD' };

/**
 * [COORD 22 Oct] A platform admin retries the scan of HELD evidence (the scanner was up but failed on it,
 * or its rescans ran out). It leaves the quarantine ONLY on a CLEAN answer (released like the job does;
 * `trail` writes the admin's audit row in the same transaction as the release). A signature quarantines
 * it like any positive. Anything else: it stays held. Never released on a person's word alone.
 */
export async function retryHeldEvidenceScan(
  deps: RescanDeps & { prisma: RescanDeps['prisma'] & Pick<PrismaClient, '$transaction'> },
  id: string,
  trail?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<HeldRetry> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const row = await deps.prisma.uploadScanDebt.findFirst({ where: { id, result: 'HELD', releasedAt: null, rescannedAt: null } });
  if (!row || !row.fileKey || !isHeldKey(row.fileKey)) return { outcome: 'NOT_HELD' };
  const status = await malwareScannerStatus(env);
  if (status.state !== 'ok') return { outcome: 'STILL_HELD', why: 'the malware scanner is not answering' };
  let stored: Buffer;
  let verdict: ScanVerdict;
  try {
    stored = await deps.storage.getObject(row.fileKey);
    let plaintext = stored;
    if (row.sealed) {
      const key = await deps.prisma.encryptedObject.findUnique({ where: { fileKey: row.fileKey }, select: { iv: true, authTag: true, wrappedDek: true } });
      if (!key || !key.wrappedDek) return { outcome: 'STILL_HELD', why: 'its key is gone' };
      plaintext = decryptBuffer(stored, await (deps.unwrapDek ?? defaultUnwrap())(Buffer.from(key.wrappedDek)), Buffer.from(key.iv), Buffer.from(key.authTag));
    }
    verdict = await clamdInstream(plaintext, { host: await privateScannerAddress(env['CLAMD_HOST']!.trim()), port: Number(env['CLAMD_PORT'] ?? CLAMD_DEFAULT_PORT) });
  } catch (error) {
    if ((error as { phase?: string }).phase === 'scan') await noteScanPayloadFailure();
    return { outcome: 'STILL_HELD', why: `the scan did not answer clean: ${(error as Error).message.slice(0, 120)}` };
  }
  if (verdict.result === 'FOUND') {
    await quarantineDebt(deps, row, stored, verdict.signature, now);
    return { outcome: 'FOUND', signature: verdict.signature };
  }
  const releasedKey = await releaseHeldEvidence(
    { prisma: deps.prisma, storage: deps.storage },
    row,
    { rescannedAt: now, result: 'CLEAN', quarantineKey: null },
    now,
    trail,
  );
  return releasedKey ? { outcome: 'RELEASED', releasedKey } : { outcome: 'NOT_HELD' };
}

/** Quarantined positive/unscannable copies are purged after QUARANTINE_DAYS; closed rows that map no
 *  evidence after CLOSED_ROW_DAYS. HELD evidence is never purged here (it is the evidence, referenced by
 *  its delivery record), and an evidence row that maps an issued key to its released bytes is kept. */
async function purgeOldDebt(deps: RescanDeps, now: Date): Promise<void> {
  const quarantineCutoff = new Date(now.getTime() - QUARANTINE_DAYS * 86_400_000);
  const expired = await deps.prisma.uploadScanDebt.findMany({
    where: { quarantinedAt: { lt: quarantineCutoff }, quarantineKey: { not: null }, result: { in: ['FOUND', 'UNSCANNABLE'] } },
    take: RESCAN_BATCH,
  });
  for (const row of expired) {
    await deps.storage.delete(row.quarantineKey!).catch(() => undefined);
    await deps.prisma.uploadScanDebt.updateMany({ where: { id: row.id }, data: { quarantineKey: null, fileKey: null } });
  }
  const closedCutoff = new Date(now.getTime() - CLOSED_ROW_DAYS * 86_400_000);
  await deps.prisma.uploadScanDebt.deleteMany({ where: { rescannedAt: { lt: closedCutoff }, quarantinedAt: null, releasedKey: null } });
}

function defaultUnwrap(): (wrapped: Buffer) => Promise<Buffer> {
  const keys = getKeyProvider();
  if (!keys) throw new Error('no key provider: a sealed upload cannot be opened for its rescan');
  return (wrapped) => keys.unwrapDek(wrapped);
}

function isMissingObject(error: unknown): boolean {
  const e = error as { code?: string; name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e?.code === 'ENOENT' || e?.code === 'NoSuchKey' || e?.name === 'NoSuchKey' || e?.Code === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}
