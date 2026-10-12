import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import type { FastifyBaseLogger } from 'fastify';
import { resolveLocalStorageKey, storageProviderKind } from '../../providers/storage/storage-key';
import { deleteStorageObjectAndConfirmAbsent } from '../../lib/storage-orphans';
import { writeDeletionReceipt } from '../verification/purge-receipt';

// Every mover row field that points at a stored object. A rider row has no
// vehicleInspectionUrl, so that field is simply absent there.
const FIELDS = ['nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl', 'vehicleInspectionUrl', 'profilePhotoUrl', 'vehiclePhotoUrl'] as const;
type Field = typeof FIELDS[number];
type Pointer = { role: 'rider' | 'driver'; id: string; field: Field; key: string };
const AUTHORITY_REASONS = new Set(['Unproven mover object', 'Filtered mover object census', 'Shared or held mover object', 'Unproven mover envelope']);

/** Legacy mover pointers are obligations, not deletion capabilities. Verify the
 * provider's exact subject namespace and a global census before touching bytes.
 * Unlike verification submissions, a mover may legitimately reference the same
 * object from several of its own fields. Foreign/aliased references fail closed.
 */
async function authority(tx: Prisma.TransactionClient, userId: string, pointers: Pointer[], key: string) {
  const local = storageProviderKind() === 'local';
  const relative = local && key.startsWith('/uploads/') ? key.slice(9) : key;
  if ((local && key !== `/uploads/${relative}`) || !/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Unproven mover object');
  const parts = relative.split('/');
  const encrypted = parts[0] === 'verification';
  const vehicle = parts[0] === 'vehicles';
  const owned = parts.length === 3 && (encrypted || parts[0] === 'avatars' ? parts[1] === userId
    : vehicle && pointers.some((p) => p.id === parts[1]));
  if (!owned || !(encrypted ? /^[A-Za-z0-9_-]{1,200}\.enc$/ : /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9]+$/).test(parts[2] ?? '')) {
    throw new Error('Unproven mover object');
  }
  const visibility = await tx.$queryRaw<Array<{ active: boolean }>>`
    SELECT bool_or(row_security_active(t::regclass)) AS active
    FROM unnest(ARRAY['users','riders','drivers','verification_documents','encrypted_objects']) AS t
    /* mover-erasure-global-visibility */
  `;
  if (visibility.length !== 1 || visibility[0]?.active !== false) throw new Error('Filtered mover object census');
  // Scope the census to references that could address THIS object. Every
  // spelling the local adapter resolves to the same file keeps the final path
  // segment verbatim (normalization only removes "", "." and ".." segments),
  // and S3/R2 keys are literal, so a reference containing the validated object
  // name is a complete superset of its aliases. The census is unbounded: a cap
  // would turn platform growth into permanent, silent erasure failure.
  const name = parts[2]!;
  const refs = await tx.$queryRaw<Array<{ owner: string; key: string; held: boolean }>>`
    SELECT * FROM (
      SELECT id AS owner, avatar AS key, false AS held FROM users WHERE strpos(avatar, ${name}) > 0
      UNION ALL SELECT "userId", k, false FROM riders, unnest(ARRAY["nationalIdUrl","driverLicenseUrl","vehicleInsuranceUrl","profilePhotoUrl","vehiclePhotoUrl"]) AS k WHERE strpos(k, ${name}) > 0
      UNION ALL SELECT "userId", k, false FROM drivers, unnest(ARRAY["nationalIdUrl","driverLicenseUrl","vehicleInsuranceUrl","vehicleInspectionUrl","profilePhotoUrl","vehiclePhotoUrl"]) AS k WHERE strpos(k, ${name}) > 0
      UNION ALL SELECT "userId", "fileUrl", "legalHoldId" IS NOT NULL FROM verification_documents WHERE strpos("fileUrl", ${name}) > 0
      UNION ALL SELECT "createdBy", "fileKey", false FROM encrypted_objects WHERE strpos("fileKey", ${name}) > 0
    ) AS refs WHERE key IS NOT NULL AND key <> ''
    /* mover-erasure-object-references */
  `;
  for (const ref of refs) {
    let same = ref.key === key;
    if (local) {
      try { same = resolveLocalStorageKey(ref.key) === resolveLocalStorageKey(key); } catch { /* an invalid key cannot address this object */ }
    }
    if (same && (ref.owner !== userId || ref.key !== key || ref.held)) throw new Error('Shared or held mover object');
  }
  if (!encrypted) return null;
  const meta = await tx.encryptedObject.findUnique({ where: { fileKey: key } });
  if (!meta || meta.createdBy !== userId || !Number.isSafeInteger(meta.sizeBytes)
    || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(meta.mimeType) || !/^[a-f0-9]{64}$/i.test(meta.sha256)
    || meta.iv.length !== 12 || meta.authTag.length !== 16 || meta.sizeBytes <= 0
    || (!meta.shreddedAt && !meta.wrappedDek?.length)) throw new Error('Unproven mover envelope');
  return meta;
}

/** Explicit account erasure purges immediately (the approved alternative to
 * the retention draft's 90-day document clock). A hold overrides it. Each source
 * pointer remains until a confirmed-absence receipt commits with pointer clear;
 * the account tombstone's standing retry sweep therefore cannot lose an object.
 */
export async function eraseMoverObjects(db: PrismaClient, storage: StorageProvider, userId: string, log?: Pick<FastifyBaseLogger, 'warn'>) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE /* mover-erasure-authority */`;
    const [rider, driver] = await Promise.all([
      tx.rider.findUnique({ where: { userId } }), tx.driver.findUnique({ where: { userId } }),
    ]);
    const pointers: Pointer[] = [];
    for (const [role, row] of [['rider', rider], ['driver', driver]] as const) {
      if (row) for (const field of FIELDS) { const key = (row as Partial<Record<Field, string | null>>)[field]; if (key) pointers.push({ role, id: row.id, field, key }); }
    }
    if (!pointers.length) return { pending: 0, held: 0 };
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true, tenantId: true } });
    if (user.phone !== `deleted:${userId}`) throw new Error('Mover erasure requires committed account closure');

    // Legacy columns have no document-level hold FK. Conservatively retain them
    // under ANY active subject hold, including one limited to a submission.
    if (await tx.docLegalHold.count({ where: { subjectUserId: userId, releasedAt: null } }) > 0) {
      return { pending: 0, held: new Set(pointers.map((p) => p.key)).size };
    }
    let pending = 0;
    // Every object left behind is named for operators: which fields still
    // point at it and why. The key itself is digested; the retry sweep and the
    // retained pointer carry the obligation.
    const leavePending = (key: string, reason: string) => {
      pending += 1;
      log?.warn({
        userId, reason,
        fields: pointers.filter((p) => p.key === key).map((p) => `${p.role}.${p.field}`),
        keyDigest: createHash('sha256').update(key).digest('hex').slice(0, 16),
      }, 'mover object erasure pending');
    };
    for (const key of new Set(pointers.map((p) => p.key))) {
      let meta;
      try { meta = await authority(tx, userId, pointers, key); } catch (error) {
        const message = error instanceof Error ? error.message : '';
        leavePending(key, AUTHORITY_REASONS.has(message) ? message : 'Object authority census failed');
        continue;
      }
      // Capture truthful photo receipt evidence before deleting. A read failure
      // other than confirmed absence keeps the pointer due for retry.
      let contentHash = meta ? Buffer.from(meta.sha256, 'hex') : null;
      let bytesDeleted = BigInt(meta?.sizeBytes ?? 0);
      if (!meta) {
        try {
          const before = await storage.getObject(key);
          contentHash = createHash('sha256').update(before).digest();
          bytesDeleted = BigInt(before.length);
        } catch (error) {
          const missing = error as { code?: string; name?: string };
          if (missing?.code !== 'ENOENT' && missing?.name !== 'NoSuchKey' && missing?.name !== 'NotFound') { leavePending(key, 'Object read failed'); continue; }
        }
      }
      if (meta) await tx.encryptedObject.updateMany({ where: { fileKey: key, createdBy: userId }, data: { wrappedDek: null, shreddedAt: meta.shreddedAt ?? new Date() } });
      if (!await deleteStorageObjectAndConfirmAbsent(storage, key)) { leavePending(key, 'Object absence not confirmed'); continue; }
      const matching = pointers.filter((p) => p.key === key);
      for (const p of matching) {
        if (p.role === 'rider') await tx.rider.update({ where: { id: p.id }, data: { [p.field]: null } });
        else await tx.driver.update({ where: { id: p.id }, data: { [p.field]: p.field === 'driverLicenseUrl' || p.field === 'vehicleInsuranceUrl' ? '' : null } });
      }
      await writeDeletionReceipt(tx, {
        submissionId: `mover:${matching[0]!.id}:${createHash('sha256').update(key).digest('hex')}`,
        subjectId: userId, tenantId: user.tenantId, docTypeCode: 'legacy_mover_object', deletedBy: userId,
        evidence: { sha256: contentHash, bytesDeleted, storeLocations: [`storage:${key}`], probe: 'CONFIRMED_ABSENT' },
      });
    }
    return { pending, held: 0 };
  }, { timeout: 30_000 });
}
