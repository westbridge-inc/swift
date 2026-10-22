import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { resolveLocalStorageKey, storageProviderKind } from '../../providers/storage/storage-key';
import { deleteStorageObjectAndConfirmAbsent } from '../../lib/storage-orphans';
import { censusSeesEveryRow, type CensusVisibilityRow } from '../../lib/census-visibility';
import { runAsSystem } from '../../plugins/tenant-context';
import { writeDeletionReceipt } from '../verification/purge-receipt';
import { UNCLAIMED_UPLOAD_DAYS, UPLOAD_DAY_MS } from '../verification/upload-window';

/**
 * [Row 331 · DSAR-ERASURE · GUARDRAILS §2 "honour deletion end to end"]
 *
 * Account erasure already takes every verification DOCUMENT (its own object)
 * and every legacy mover pointer. Three things were left behind:
 *  - an upload nobody claimed: POST /verification/upload writes one encrypted
 *    object per file, and a file that never became a document (an abandoned
 *    onboarding, the optional L2 ID selfie, which is checked but never linked)
 *    had no erasure path at all;
 *  - the shift liveness selfies (liveness/<user>/…): erasure deleted their rows,
 *    and with them the only record of where the photos were;
 *  - the content fingerprint: a shredded object kept its sha256 and owner, so the
 *    same document uploaded later linked the erased account again.
 *
 * Same rules as the mover pass: the account closure must already be committed,
 * an object is touched only with proven authority (the subject's own namespace,
 * one owner, no other reference anywhere), a legal hold keeps everything (checked
 * under the subject lock, in the same transaction as each write), and an
 * object whose absence is not confirmed stays an open obligation that the
 * account tombstone's daily retry sweep finishes.
 */

type Log = Pick<FastifyBaseLogger, 'warn' | 'error'>;

/** A pass that cannot finish never aborts the rest of the erasure: it rolls back and stays owed. */
async function owed<T>(log: Log | undefined, userId: string, what: string, unfinished: T, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (err) {
    log?.error({ err, userId }, `${what} erasure pending: the pass could not complete`);
    return unfinished;
  }
}

/** Who erased an upload the open-account sweep took (the receipt's deletedBy). */
export const UNCLAIMED_SWEEP_ACTOR = 'unclaimed-upload-sweep';

/** What a forgotten fingerprint reads as. Never a hex digest, so it can never equal a real upload's. */
export const ERASED_FINGERPRINT = 'erased';

const VERIFICATION_NAME = /^[A-Za-z0-9_-]{1,200}\.enc$/;
const PHOTO_NAME = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,16}$/;

/** The provider-canonical key the server wrote for this subject in this folder, or null. */
export function canonicalSubjectKey(key: string, userId: string, folder: 'verification' | 'liveness'): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) return null;
  const local = storageProviderKind() === 'local';
  const relative = local ? (key.startsWith('/uploads/') ? key.slice('/uploads/'.length) : null) : key;
  if (relative === null || (!local && key.startsWith('/'))) return null;
  const parts = relative.split('/');
  if (parts.length !== 3 || parts[0] !== folder || parts[1] !== userId) return null;
  return (folder === 'verification' ? VERIFICATION_NAME : PHOTO_NAME).test(parts[2]!) ? parts[2]! : null;
}

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function sameObject(a: string, b: string): boolean {
  if (a === b) return true;
  if (storageProviderKind() !== 'local') return false;
  try { return resolveLocalStorageKey(a) === resolveLocalStorageKey(b); } catch { return false; }
}

/** The census reads every tenant's rows; a database that filters them cannot prove an object is unshared.
 * [Phase C] Proven per table on THIS connection (lib/census-visibility): no row security applied (the
 * wall-off posture), or the system login under the tenant contract alone. Every pass of this module
 * runs its transaction on the system login (runAsSystem below), so a walled erasure can prove it. */
async function censusVisible(tx: Prisma.TransactionClient, tables: string[]): Promise<boolean> {
  for (const table of tables) {
    const rows = await tx.$queryRaw<CensusVisibilityRow[]>`
      SELECT row_security_active(${table}::regclass) AS "active",
             COALESCE((SELECT pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'swift_bypass_rls'), false) AS "bypass",
             COALESCE((SELECT json_agg(json_build_object(
                         'permissive', p.polpermissive,
                         'cmd', p.polcmd::text,
                         'applies', p.polroles = '{0}'::oid[]
                                    OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = ANY(p.polroles) AND pg_has_role(current_user, r.oid, 'MEMBER')),
                         'qual', pg_get_expr(p.polqual, p.polrelid)))
                         FROM pg_policy p WHERE p.polrelid = ${table}::regclass), '[]'::json) AS "policies"
      /* upload-erasure-global-visibility */
    `;
    if (!censusSeesEveryRow(rows)) return false;
  }
  return true;
}

/** The subject's row lock, taken before anything is read (the same lock order as the mover pass). */
async function lockSubject(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE /* upload-erasure-authority */`;
}

/**
 * Any active legal hold on the person freezes every erasure write of this module
 * (uploads, liveness photos, fingerprints): the retry sweep finishes after release.
 * Read inside the caller's transaction AFTER lockSubject: placing a hold takes the
 * same users row lock (legal-hold.ts placeDocLegalHoldIn), so a hold is either
 * committed and seen here, or waits until this transaction is done. Never a
 * check-then-delete race.
 */
async function underLegalHold(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
  return await tx.docLegalHold.count({ where: { subjectUserId: userId, releasedAt: null } }) > 0;
}

/** Only a committed closure authorizes any of this; checked once there is work to do. */
async function closedAccount(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true, tenantId: true } });
  if (user.phone !== `deleted:${userId}`) throw new Error('Upload erasure requires committed account closure');
  return user;
}

/**
 * [ROLE-DOCS · owner 21 Oct 2026 · REVIEW-F #2001 S3-1] The selfie store build 9 still uploads beside a customer's ID.
 * The intake no longer reads it (a customer never gives a photo), so it is a face Swift does not need: it is erased
 * NOW, not left as an unclaimed upload until the account closes. Same proof as the account-erasure pass, for this one
 * key only: it must be the caller's own encrypted upload in their own verification folder, named by nothing else
 * (no document, mover, recovery or other envelope), and the person must hold no legal hold. Crypto-shred first, then
 * the bytes; an absence the provider does not confirm stays open for the account-erasure retry. Never throws: the
 * customer's ID intake has already succeeded. Returns what happened, for the caller's log and tests.
 */
export async function discardUnusedCustomerSelfie(
  db: PrismaClient, storage: StorageProvider, userId: string, fileKey: string, log?: Log,
): Promise<'ERASED' | 'NOT_OWN' | 'CLAIMED' | 'HELD' | 'PENDING'> {
  return owed(log, userId, 'unused customer selfie', 'PENDING' as const, () => runAsSystem('customer-id:discard-unused-selfie', () => db.$transaction(async (tx) => {
    await lockSubject(tx, userId);
    const name = canonicalSubjectKey(fileKey, userId, 'verification');
    const own = name ? await tx.encryptedObject.findFirst({ where: { fileKey, createdBy: userId, shreddedAt: null } }) : null;
    if (!name || !own) return 'NOT_OWN' as const;
    if (!await censusVisible(tx, ['verification_documents', 'riders', 'drivers', 'account_recoveries', 'encrypted_objects'])) return 'PENDING' as const;
    const refs = await tx.$queryRaw<Array<{ source: string; owner: string; key: string }>>`
      SELECT * FROM (
        SELECT 'document' AS source, "userId" AS owner, "fileUrl" AS key FROM verification_documents WHERE strpos("fileUrl", ${name}) > 0
        UNION ALL SELECT 'mover', "userId", k FROM riders, unnest(ARRAY["nationalIdUrl","driverLicenseUrl","vehicleInsuranceUrl","profilePhotoUrl","vehiclePhotoUrl"]) AS k WHERE strpos(k, ${name}) > 0
        UNION ALL SELECT 'mover', "userId", k FROM drivers, unnest(ARRAY["nationalIdUrl","driverLicenseUrl","vehicleInsuranceUrl","vehicleInspectionUrl","profilePhotoUrl","vehiclePhotoUrl"]) AS k WHERE strpos(k, ${name}) > 0
        UNION ALL SELECT 'recovery', "userId", k FROM account_recoveries, unnest(ARRAY["idDocumentUrl","selfieUrl"]) AS k WHERE strpos(k, ${name}) > 0
        UNION ALL SELECT 'envelope', "createdBy", "fileKey" FROM encrypted_objects WHERE strpos("fileKey", ${name}) > 0
      ) AS refs WHERE key IS NOT NULL AND key <> ''
      /* customer-selfie-discard-references */
    `;
    const same = refs.filter((r) => sameObject(r.key, fileKey));
    if (same.some((r) => r.source !== 'envelope' || r.owner !== userId || r.key !== fileKey)) return 'CLAIMED' as const;
    if (await underLegalHold(tx, userId)) return 'HELD' as const;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    await tx.encryptedObject.updateMany({ where: { fileKey, createdBy: userId, shreddedAt: null }, data: { wrappedDek: null } });
    if (!await deleteStorageObjectAndConfirmAbsent(storage, fileKey)) return 'PENDING' as const;
    await tx.encryptedObject.updateMany({ where: { fileKey, createdBy: userId, shreddedAt: null }, data: { shreddedAt: new Date(), sha256: ERASED_FINGERPRINT } });
    await writeDeletionReceipt(tx, {
      submissionId: `upload:${digest(fileKey)}`, subjectId: userId, tenantId: user.tenantId, docTypeCode: 'unused_customer_selfie', deletedBy: 'customer-id-intake',
      evidence: {
        sha256: /^[a-f0-9]{64}$/i.test(own.sha256) ? Buffer.from(own.sha256, 'hex') : null,
        bytesDeleted: BigInt(own.sizeBytes),
        storeLocations: [`storage:${fileKey}`, `encrypted_object:${fileKey}`],
        probe: 'CONFIRMED_ABSENT',
      },
    });
    return 'ERASED' as const;
  }, { timeout: 60_000 })));
}

/**
 * Every encrypted upload this person made that no document and no mover pointer
 * claims: the bytes are deleted, the key shredded, the fingerprint forgotten, and
 * a receipt written. Claimed objects belong to the document and mover passes.
 */
export async function eraseUnclaimedUploads(db: PrismaClient, storage: StorageProvider, userId: string, log?: Log) {
  return eraseUnclaimed(db, storage, userId, { scope: 'closure' }, log);
}

/**
 * [Row 249 · COORD 17:09Z option A] An upload nobody claimed within UNCLAIMED_UPLOAD_DAYS is erased while the
 * account stays open: the same census, hold freeze, crypto-shred, confirmed absence and receipt as the account
 * erasure, for this person's uploads made before `olderThan` only. A claim can never race it: a document or an
 * identity check refuses an upload older than UPLOAD_CLAIM_DAYS (one day inside this window, upload-window.ts
 * assertClaimableUpload), and in this mode an account-recovery pointer is a claim too (the case still needs it).
 */
export async function eraseStaleUnclaimedUploads(db: PrismaClient, storage: StorageProvider, userId: string, olderThan: Date, log?: Log) {
  return eraseUnclaimed(db, storage, userId, { scope: 'stale', olderThan }, log);
}


/**
 * The daily sweep: every person with an unshredded upload older than the window, a batch at a time. Each person's
 * pass is the locked eraser above; one that cannot finish stays owed and the next run takes it again.
 */
export async function sweepStaleUnclaimedUploads(
  db: PrismaClient, storage: StorageProvider, opts: { now?: Date; page?: number; log?: Log } = {},
): Promise<{ people: number; erased: number; held: number; pending: number }> {
  const olderThan = new Date((opts.now ?? new Date()).getTime() - UNCLAIMED_UPLOAD_DAYS * UPLOAD_DAY_MS);
  // Every stale unshredded upload, a page at a time (keyset), so a person whose old uploads are all claimed
  // never starves the ones behind them; an object a document names is the document's, never a candidate.
  const people = new Set<string>();
  for (let after: string | undefined; ;) {
    const rows = await db.encryptedObject.findMany({
      where: { shreddedAt: null, createdAt: { lt: olderThan }, ...(after ? { fileKey: { gt: after } } : {}) },
      select: { fileKey: true, createdBy: true }, orderBy: { fileKey: 'asc' }, take: opts.page ?? 500,
    });
    if (!rows.length) break;
    after = rows[rows.length - 1]!.fileKey;
    const named = new Set((await db.verificationDocument.findMany({
      where: { fileUrl: { in: rows.map((r) => r.fileKey) } }, select: { fileUrl: true },
    })).map((d) => d.fileUrl));
    for (const r of rows) if (!named.has(r.fileKey)) people.add(r.createdBy);
  }
  const total = { people: people.size, erased: 0, held: 0, pending: 0 };
  for (const userId of [...people].sort()) {
    const r = await eraseStaleUnclaimedUploads(db, storage, userId, olderThan, opts.log);
    total.erased += r.erased; total.held += r.held; total.pending += r.pending;
  }
  return total;
}

type UnclaimedMode = { scope: 'closure' } | { scope: 'stale'; olderThan: Date };

async function eraseUnclaimed(db: PrismaClient, storage: StorageProvider, userId: string, mode: UnclaimedMode, log?: Log) {
  const capability = mode.scope === 'closure' ? 'account:erasure-unclaimed-uploads' : 'verification:unclaimed-upload-sweep';
  return owed(log, userId, 'unclaimed upload', { pending: 1, held: 0, erased: 0 }, () => runAsSystem(capability, () => db.$transaction(async (tx) => {
    await lockSubject(tx, userId);
    const own = (await tx.encryptedObject.findMany({
      where: { createdBy: userId, shreddedAt: null, ...(mode.scope === 'stale' ? { createdAt: { lt: mode.olderThan } } : {}) },
      orderBy: { fileKey: 'asc' },
    })).filter((c) => c.createdBy === userId && c.shreddedAt === null && (mode.scope !== 'stale' || c.createdAt < mode.olderThan));
    if (!own.length) return { pending: 0, held: 0, erased: 0 };
    // A document that names the object exactly owns it (the document pass, and its hold).
    const named = new Set((await tx.verificationDocument.findMany({
      where: { fileUrl: { in: own.map((c) => c.fileKey) } }, select: { fileUrl: true },
    })).map((d) => d.fileUrl));
    const candidates = own.filter((c) => !named.has(c.fileKey));
    if (!candidates.length) return { pending: 0, held: 0, erased: 0 };
    // Erasure: only a committed closure authorizes it. The open-account sweep: only the age of an unclaimed upload.
    const user = mode.scope === 'closure'
      ? await closedAccount(tx, userId)
      : await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    let pending = 0;
    const leavePending = (key: string, reason: string) => {
      pending += 1;
      log?.warn({ userId, reason, keyDigest: digest(key).slice(0, 16) }, 'unclaimed upload erasure pending');
    };
    if (!await censusVisible(tx, ['verification_documents', 'riders', 'drivers', 'account_recoveries', 'encrypted_objects'])) {
      for (const c of candidates) leavePending(c.fileKey, 'Filtered upload census');
      return { pending, held: 0, erased: 0 };
    }
    const unclaimed: typeof candidates = [];
    for (const c of candidates) {
      const name = canonicalSubjectKey(c.fileKey, userId, 'verification');
      if (!name) { leavePending(c.fileKey, 'Unproven upload key'); continue; }
      const refs = await tx.$queryRaw<Array<{ source: string; owner: string; key: string }>>`
        SELECT * FROM (
          SELECT 'document' AS source, "userId" AS owner, "fileUrl" AS key FROM verification_documents WHERE strpos("fileUrl", ${name}) > 0
          UNION ALL SELECT 'mover', "userId", k FROM riders, unnest(ARRAY["nationalIdUrl","driverLicenseUrl","vehicleInsuranceUrl","profilePhotoUrl","vehiclePhotoUrl"]) AS k WHERE strpos(k, ${name}) > 0
          UNION ALL SELECT 'mover', "userId", k FROM drivers, unnest(ARRAY["nationalIdUrl","driverLicenseUrl","vehicleInsuranceUrl","vehicleInspectionUrl","profilePhotoUrl","vehiclePhotoUrl"]) AS k WHERE strpos(k, ${name}) > 0
          UNION ALL SELECT 'recovery', "userId", k FROM account_recoveries, unnest(ARRAY["idDocumentUrl","selfieUrl"]) AS k WHERE strpos(k, ${name}) > 0
          UNION ALL SELECT 'envelope', "createdBy", "fileKey" FROM encrypted_objects WHERE strpos("fileKey", ${name}) > 0
        ) AS refs WHERE key IS NOT NULL AND key <> ''
        /* upload-erasure-object-references */
      `;
      const same = refs.filter((r) => sameObject(r.key, c.fileKey));
      // A document or mover pointer claims it: those passes own it (and its hold).
      if (same.some((r) => r.source === 'document' || r.source === 'mover')) continue;
      // While the account is open, an account-recovery case that names the upload still needs it.
      if (mode.scope === 'stale' && same.some((r) => r.source === 'recovery')) continue;
      if (same.some((r) => r.source !== 'envelope' ? r.owner !== userId : r.owner !== userId || r.key !== c.fileKey)) {
        leavePending(c.fileKey, 'Shared upload object');
        continue;
      }
      unclaimed.push(c);
    }
    if (!unclaimed.length) return { pending, held: 0, erased: 0 };
    // Uploads have no document-level hold; any active hold on the person keeps them all.
    if (await underLegalHold(tx, userId)) {
      return { pending, held: unclaimed.length, erased: 0 };
    }
    let erased = 0;
    for (const c of unclaimed) {
      // Crypto-shred first: without its key the ciphertext is unreadable from any copy.
      await tx.encryptedObject.updateMany({ where: { fileKey: c.fileKey, createdBy: userId, shreddedAt: null }, data: { wrappedDek: null } });
      if (!await deleteStorageObjectAndConfirmAbsent(storage, c.fileKey)) {
        // shreddedAt stays empty: the open obligation the retry sweep finds again.
        leavePending(c.fileKey, 'Upload absence not confirmed');
        continue;
      }
      await tx.encryptedObject.updateMany({
        where: { fileKey: c.fileKey, createdBy: userId, shreddedAt: null },
        data: { shreddedAt: new Date(), sha256: ERASED_FINGERPRINT },
      });
      await writeDeletionReceipt(tx, {
        submissionId: `upload:${digest(c.fileKey)}`, subjectId: userId, tenantId: user.tenantId, docTypeCode: 'unclaimed_upload', deletedBy: mode.scope === 'closure' ? userId : UNCLAIMED_SWEEP_ACTOR,
        evidence: {
          sha256: /^[a-f0-9]{64}$/i.test(c.sha256) ? Buffer.from(c.sha256, 'hex') : null,
          bytesDeleted: BigInt(c.sizeBytes),
          storeLocations: [`storage:${c.fileKey}`, `encrypted_object:${c.fileKey}`],
          probe: 'CONFIRMED_ABSENT',
        },
      });
      erased += 1;
    }
    return { pending, held: 0, erased };
  }, { timeout: 60_000 })));
}

/**
 * The shift liveness selfies go with the account. A row is deleted only after
 * its photo is confirmed gone: until then the row is the obligation.
 */
export async function eraseLivenessSelfies(db: PrismaClient, storage: StorageProvider, userId: string, log?: Log) {
  return owed(log, userId, 'liveness selfie', { pending: 1, held: 0, erased: 0 }, () => runAsSystem('account:erasure-liveness-selfies', () => db.$transaction(async (tx) => {
    await lockSubject(tx, userId);
    const rows = await tx.livenessCheck.findMany({ where: { userId }, select: { selfieUrl: true } });
    // A hold keeps the photos AND their rows (the rows say where the photos are).
    if (rows.length && await underLegalHold(tx, userId)) return { pending: 0, held: new Set(rows.map((r) => r.selfieUrl)).size, erased: 0 };
    const kept: string[] = [];
    let erased = 0;
    const leavePending = (key: string, reason: string) => {
      kept.push(key);
      log?.warn({ userId, reason, keyDigest: digest(key).slice(0, 16) }, 'liveness selfie erasure pending');
    };
    const photos = [...new Set(rows.map((r) => r.selfieUrl))];
    if (photos.length) {
      await closedAccount(tx, userId);
      const visible = await censusVisible(tx, ['"LivenessCheck"']);
      for (const key of photos) {
        if (!visible) { leavePending(key, 'Filtered liveness census'); continue; }
        const name = canonicalSubjectKey(key, userId, 'liveness');
        if (!name) { leavePending(key, 'Unproven liveness key'); continue; }
        const refs = await tx.$queryRaw<Array<{ owner: string; key: string }>>`
          SELECT "userId" AS owner, "selfieUrl" AS key FROM "LivenessCheck" WHERE strpos("selfieUrl", ${name}) > 0
          /* upload-erasure-liveness-references */
        `;
        if (refs.some((r) => sameObject(r.key, key) && (r.owner !== userId || r.key !== key))) { leavePending(key, 'Shared liveness object'); continue; }
        if (!await deleteStorageObjectAndConfirmAbsent(storage, key)) { leavePending(key, 'Liveness absence not confirmed'); continue; }
        erased += 1;
      }
    }
    // Every row goes except those whose photo is still owed: they are the obligation.
    await tx.livenessCheck.deleteMany({ where: { userId, ...(kept.length ? { selfieUrl: { notIn: kept } } : {}) } });
    return { pending: kept.length, held: 0, erased };
  }, { timeout: 60_000 })));
}

/**
 * The account's shredded objects stop carrying their content hash, so a later
 * upload of the same document cannot find (and re-link) the erased account. Only
 * objects nothing still points at: a held or pending document keeps its hash
 * until it is purged, and the next re-sweep forgets it then. The deletion
 * receipts keep theirs (append-only legal evidence that no matcher reads).
 */
export async function forgetErasedFingerprints(db: PrismaClient, userId: string, log?: Log): Promise<{ forgotten: number; pending: number; held: number }> {
  return owed(log, userId, 'fingerprint', { forgotten: 0, pending: 1, held: 0 }, () => runAsSystem('account:erasure-fingerprints', () => db.$transaction(async (tx) => {
    await lockSubject(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } });
    // Never for a live account: its purged documents still answer the duplicate check.
    if (user.phone !== `deleted:${userId}`) return { forgotten: 0, pending: 0, held: 0 };
    const remembered = (await tx.encryptedObject.findMany({
      where: { createdBy: userId, shreddedAt: { not: null }, NOT: { sha256: ERASED_FINGERPRINT } }, select: { createdBy: true, shreddedAt: true, sha256: true },
    })).filter((o) => o.createdBy === userId && o.shreddedAt !== null && o.sha256 !== ERASED_FINGERPRINT);
    if (!remembered.length) return { forgotten: 0, pending: 0, held: 0 };
    // A hold overwrites nothing of the person; the retry forgets them after release.
    if (await underLegalHold(tx, userId)) return { forgotten: 0, pending: 0, held: remembered.length };
    // A census that cannot see every tenant cannot prove an object unreferenced: forget nothing, stay owed.
    if (!await censusVisible(tx, ['verification_documents', 'riders', 'drivers', 'encrypted_objects'])) return { forgotten: 0, pending: 1, held: 0 };
    const forgotten = await tx.$executeRaw`
      UPDATE encrypted_objects AS eo SET sha256 = ${ERASED_FINGERPRINT}
      WHERE eo."createdBy" = ${userId} AND eo."shreddedAt" IS NOT NULL AND eo.sha256 <> ${ERASED_FINGERPRINT}
        AND NOT EXISTS (SELECT 1 FROM verification_documents d
          WHERE d."fileUrl" <> '' AND strpos(d."fileUrl", regexp_replace(eo."fileKey", '^.*/', '')) > 0)
        AND NOT EXISTS (SELECT 1 FROM riders r, unnest(ARRAY[r."nationalIdUrl", r."driverLicenseUrl", r."vehicleInsuranceUrl", r."profilePhotoUrl", r."vehiclePhotoUrl"]) AS k
          WHERE k <> '' AND strpos(k, regexp_replace(eo."fileKey", '^.*/', '')) > 0)
        AND NOT EXISTS (SELECT 1 FROM drivers dr, unnest(ARRAY[dr."nationalIdUrl", dr."driverLicenseUrl", dr."vehicleInsuranceUrl", dr."vehicleInspectionUrl", dr."profilePhotoUrl", dr."vehiclePhotoUrl"]) AS k
          WHERE k <> '' AND strpos(k, regexp_replace(eo."fileKey", '^.*/', '')) > 0)
      /* upload-erasure-forget-fingerprints */
    `;
    return { forgotten, pending: 0, held: 0 };
  })));
}
