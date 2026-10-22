/**
 * [Row 312 · COORD ruling 21 Oct] The debt of an upload stored WITHOUT a malware scan.
 *
 * scanUpload answers 'UNSCANNED' for evidence (safety evidence, delivery and handover proof) while the
 * scanner is down, and for the
 * BYPASS_SURFACES under MALWARE_SCAN_BYPASS=1. The route stores the file and then records it here:
 * one upload_scan_debts row holding the object key, the file's sha256, its surface, why it was not
 * scanned and whether the stored bytes are sealed (envelope-encrypted). No person or tenant id and
 * never the content. A row that cannot be written means the upload is not kept: the object is
 * deleted and the upload refused (503), so nothing unscanned is ever stored untracked.
 *
 * The upload-rescan job (rescanUploadDebt) scans each open row once clamd answers again: the stored
 * bytes (a sealed object opened with its own key, so the PLAINTEXT is scanned, as at upload).
 *  - clean -> closed; the key is forgotten;
 *  - a signature -> the stored bytes (still ciphertext if sealed) are moved to the quarantine folder,
 *    the original is deleted (so nothing serves it any more), the row records the signature, and ops
 *    are paged. A quarantined copy is purged after QUARANTINE_DAYS;
 *  - the object already erased, or a sealed one whose key was shredded -> closed without a scan;
 *  - a rescan that keeps failing (unreadable object, bytes that no longer open, a scanner error):
 *    after MAX_RESCAN_ATTEMPTS it is UNSCANNABLE and treated exactly like a positive (quarantined,
 *    the original deleted, recorded, paged). Never left served and open. Rows are taken fewest
 *    attempts first, so failing rows can never fill every batch and starve newer uploads.
 * Closed rows are deleted after CLOSED_ROW_DAYS; quarantine rows stay as the record.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError } from '../utils/errors';
import type { NotificationService } from '../modules/notification/notification.service';
import { pageOps } from '../modules/ops/ops-page';
import { decryptBuffer, getKeyProvider } from '../providers/storage/envelope';
import type { StorageProvider } from '../providers/storage/storage-provider';
import {
  clamdInstream, malwareScanBypassOn, malwareScannerStatus, privateScannerAddress, CLAMD_DEFAULT_PORT,
  NEVER_REFUSED_SURFACES, type ScanOutcome, type UploadSurface,
} from './malware-scan';

export const QUARANTINE_FOLDER = 'quarantine/uploads';
/** Evidence the scanner was UP but could not scan is stored straight here by its route (never served). */
export const QUARANTINE_HELD_FOLDER = 'quarantine/held';

/** The folder an upload is stored in: the held quarantine folder for scan outcome 'QUARANTINE'. */
export function heldFolder(outcome: ScanOutcome, folder: string): string {
  return outcome === 'QUARANTINE' ? `${QUARANTINE_HELD_FOLDER}/${folder}` : folder;
}

export { assertServableKey, isQuarantineKey } from '../providers/storage/quarantine-key';

/** A platform admin's release of held evidence after a manual check: once, and only a HELD row. */
export async function releaseHeldUpload(prisma: DebtDb, id: string, now = new Date()): Promise<boolean> {
  const r = await prisma.uploadScanDebt.updateMany({ where: { id, result: 'HELD', releasedAt: null }, data: { releasedAt: now } });
  return r.count === 1;
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

/** Call right after storing an upload whose scan outcome is `outcome`. A no-op unless it is 'UNSCANNED'. */
export async function recordUnscannedUpload(
  prisma: DebtDb,
  outcome: ScanOutcome,
  input: { surface: UploadSurface; fileKey: string; buffer: Buffer; sealed?: boolean; storage: Pick<StorageProvider, 'delete'> },
  env: Env = process.env,
): Promise<void> {
  if (outcome !== 'UNSCANNED' && outcome !== 'QUARANTINE') return;
  const reason = NEVER_REFUSED_SURFACES.has(input.surface) ? 'evidence' : malwareScanBypassOn(env) ? 'bypass' : 'evidence';
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  try {
    await prisma.uploadScanDebt.create({
      data: outcome === 'QUARANTINE'
        // Held: already in the quarantine folder (the route stored it there); not rescanned; a platform
        // admin releases it after a manual check. Paged by the scanner watch while unreleased.
        ? { surface: input.surface, reason: 'evidence', fileKey: input.fileKey, sealed: input.sealed === true, sha256, result: 'HELD', quarantinedAt: new Date(), quarantineKey: input.fileKey }
        : { surface: input.surface, reason, fileKey: input.fileKey, sealed: input.sealed === true, sha256 },
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
  /** Out of service: the bytes AS STORED (a sealed one stays ciphertext; its key row is found by the
   *  original key) to the quarantine folder when they can be read, the original deleted, recorded, paged. */
  const quarantine = async (row: (typeof open)[number], stored: Buffer | null, signature: string, attempts?: number) => {
    const fileKey = row.fileKey!;
    const quarantineKey = stored
      ? (await deps.storage.upload({ buffer: stored, filename: 'quarantined.bin', mimeType: 'application/octet-stream', folder: `${QUARANTINE_FOLDER}/${row.id}` })).url
      : null;
    await deps.storage.delete(fileKey);
    const result = signature === 'UNSCANNABLE' ? 'UNSCANNABLE' : 'FOUND';
    await close(row.id, { result, signature: signature.slice(0, 200), quarantinedAt: now, quarantineKey, fileKey: row.sealed ? fileKey : null, ...(attempts ? { attempts } : {}) });
    await pageOps({ prisma: deps.prisma as PrismaClient, redis: deps.redis, notifications: deps.notifications }, {
      key: 'ops_page:upload-quarantined',
      windowSeconds: 3600,
      title: UPLOAD_QUARANTINED_PAGE_TITLE,
      body: result === 'FOUND'
        ? `An upload stored without a scan (${row.surface}, ${row.reason}) matched ${signature.slice(0, 120)}. It was moved to quarantine and no longer serves; check what used it (upload_scan_debts ${row.id}).`
        : `An upload stored without a scan (${row.surface}, ${row.reason}) could not be rescanned after ${MAX_RESCAN_ATTEMPTS} tries, so it was taken out of service${stored ? ' and moved to quarantine' : ' (its bytes could not be read)'}; check what used it (upload_scan_debts ${row.id}).`,
      data: { kind: 'ops_upload_quarantined', surface: row.surface, reason: row.reason, debtId: row.id, signature: signature.slice(0, 200) },
    });
  };
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
        await close(row.id, { result: 'CLEAN', fileKey: null });
        result.clean += 1;
        continue;
      }
      await quarantine(row, stored, verdict.signature);
      result.quarantined += 1;
    } catch {
      result.failed += 1;
      const attempts = row.attempts + 1;
      if (attempts < MAX_RESCAN_ATTEMPTS) {
        await deps.prisma.uploadScanDebt.updateMany({ where: { id: row.id, rescannedAt: null }, data: { attempts: { increment: 1 } } }).catch(() => undefined);
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

/** Quarantined copies are purged after QUARANTINE_DAYS; closed clean/gone rows after CLOSED_ROW_DAYS. */
async function purgeOldDebt(deps: RescanDeps, now: Date): Promise<void> {
  const quarantineCutoff = new Date(now.getTime() - QUARANTINE_DAYS * 86_400_000);
  // Evidence is never lost: only the quarantined copies of bypass uploads are purged.
  const expired = await deps.prisma.uploadScanDebt.findMany({
    where: { quarantinedAt: { lt: quarantineCutoff }, quarantineKey: { not: null }, reason: 'bypass' },
    take: RESCAN_BATCH,
  });
  for (const row of expired) {
    await deps.storage.delete(row.quarantineKey!).catch(() => undefined);
    await deps.prisma.uploadScanDebt.updateMany({ where: { id: row.id }, data: { quarantineKey: null, fileKey: null } });
  }
  const closedCutoff = new Date(now.getTime() - CLOSED_ROW_DAYS * 86_400_000);
  await deps.prisma.uploadScanDebt.deleteMany({ where: { rescannedAt: { lt: closedCutoff }, quarantinedAt: null } });
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
