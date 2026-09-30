import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type DocumentPurgeClaim, type EncryptedObject } from '@prisma/client';
import { getTenantContext } from '../../plugins/tenant-context';
import { AppError } from '../../utils/errors';
import { resolveVerificationObject, verificationObjectUnavailable } from './object-authority';
import { registryCode } from './doc-registry';
import { writeDeletionReceipt, type PurgeEvidence } from './purge-receipt';

export type PurgeMode = 'IMAGE_ONLY' | 'FULL_RETENTION' | 'FULL_ERASURE' | 'UNATTACHED_OBJECT';
export type PurgeStorage = {
  delete(key: string): Promise<unknown>;
  getObject(key: string): Promise<unknown>;
  purgeNamespace?: () => Promise<string>;
};
export type PurgeOutcome = 'PURGED' | 'PROBE_FAILED' | 'NOT_PURGED';
type Tx = Prisma.TransactionClient;
// Process-local proof cannot be fabricated or replayed for another claim. After
// a crash the worker must perform the probe again, even if an event survived.
const observed = new WeakMap<PurgeEvidence, { claimId: string; tenantId: string }>();

export function assertPurgeTenant(tenantId: string): void {
  const ctx = getTenantContext();
  if ((ctx.mode === 'request' && ctx.tenantId !== tenantId) || (ctx.tenantId !== null && ctx.tenantId !== tenantId)) {
    throw verificationObjectUnavailable();
  }
}

export async function purgeEvent(tx: Pick<Tx, 'documentPurgeEvent'>, input: {
  tenantId: string; userId: string; claimId?: string; holdId?: string; kind: string; actorId: string; details?: Prisma.InputJsonValue;
}) {
  return tx.documentPurgeEvent.create({ data: { ...input, details: input.details ?? {} } });
}

export async function lockPurgeUser(tx: Tx, userId: string, tenantId?: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string }>>`
    SELECT id, "tenantId" FROM users WHERE id = ${userId} FOR UPDATE /* verification-document-purge-authority */
  `;
  const row = rows[0];
  if (!row || (tenantId !== undefined && row.tenantId !== tenantId)) throw verificationObjectUnavailable();
  assertPurgeTenant(row.tenantId);
  return tx.user.findUniqueOrThrow({ where: { id: userId } });
}

export async function lockDocumentSource(tx: Tx, documentId: string, userId: string) {
  await tx.$queryRaw`SELECT id FROM verification_documents WHERE id = ${documentId} AND "userId" = ${userId} FOR UPDATE`;
  return tx.verificationDocument.findFirst({ where: { id: documentId, userId } });
}

/** Ownership compatibility census must be complete on this very connection. */
export async function assertCompleteSourceCensus(tx: Tx) {
  const rows = await tx.$queryRaw<Array<{ documents: boolean; objects: boolean }>>`
    SELECT row_security_active('verification_documents'::regclass) AS documents,
      row_security_active('encrypted_objects'::regclass) AS objects /* purge-global-census-visibility */
  `;
  if (rows.length !== 1 || rows[0]!.documents !== false || rows[0]!.objects !== false) throw verificationObjectUnavailable();
}

function fingerprint(o: EncryptedObject): string {
  return createHash('sha256').update(JSON.stringify([
    o.sourceId, o.fileKey, o.createdBy, o.createdAt.toISOString(), o.sha256, o.sizeBytes, o.mimeType,
    Buffer.from(o.iv).toString('hex'), Buffer.from(o.authTag).toString('hex'), o.storageNamespace,
  ])).digest('hex');
}

async function namespaceOf(storage: PurgeStorage) {
  if (!storage.purgeNamespace) throw verificationObjectUnavailable();
  const namespace = await storage.purgeNamespace();
  if (!namespace) throw verificationObjectUnavailable();
  return namespace;
}

async function lockAndResolveSource(tx: Tx, input: { fileKey: string; userId: string; documentId?: string }, namespace: string) {
  await tx.$queryRaw`SELECT "sourceId" FROM encrypted_objects WHERE "fileKey" = ${input.fileKey} ORDER BY "sourceId" FOR UPDATE`;
  await assertCompleteSourceCensus(tx);
  const object = await resolveVerificationObject(tx, input);
  if (object.retiredClaimId || object.uploadState !== 'READY' || object.storageNamespace !== namespace) throw verificationObjectUnavailable();
  return object;
}

export async function claimDocumentPurge(db: PrismaClient, storage: PurgeStorage, input: {
  documentId: string; userId: string; tenantId: string; mode: Exclude<PurgeMode, 'UNATTACHED_OBJECT'>;
  initiatedBy: string; requireRetentionElapsed?: boolean; enforceDsarPolicy?: boolean; now?: Date;
}): Promise<DocumentPurgeClaim | null> {
  // Adapter validation can use network (versioning checks). Never inside the DB transaction.
  const namespace = await namespaceOf(storage);
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const user = await lockPurgeUser(tx, input.userId, input.tenantId);
    const doc = await lockDocumentSource(tx, input.documentId, user.id);
    if (!doc || doc.legalHoldId) return null; // hold-first authority guard
    const mode = input.mode === 'FULL_RETENTION' && user.phone === `deleted:${user.id}` ? 'FULL_ERASURE' : input.mode;
    if (doc.activePurgeClaimId) {
      const active = await tx.documentPurgeClaim.findUniqueOrThrow({ where: { id: doc.activePurgeClaimId } });
      // A caller requesting a stronger scope cannot widen an older claim.
      return active.mode === mode ? active : null;
    }
    if (mode === 'IMAGE_ONLY' && (doc.state !== 'COMMITTED' || doc.imagePurgedAt || doc.purgedAt || !doc.fileUrl)) return null;
    if (mode === 'FULL_ERASURE' ? doc.fieldsPurgedAt !== null : mode === 'FULL_RETENTION' && doc.purgedAt !== null) return null;
    if (input.requireRetentionElapsed && (!doc.retentionExpiresAt || doc.retentionExpiresAt >= now)) return null;
    if (input.enforceDsarPolicy) {
      const type = await tx.docType.findUnique({ where: { code: registryCode(user.countryCode, doc.docType) }, select: { amlRecordClass: true } });
      const [vendors, rider, driver] = await Promise.all([
        tx.vendor.count({ where: { owner: { userId: user.id }, status: 'ACTIVE' } }),
        tx.rider.findUnique({ where: { userId: user.id }, select: { documentsVerified: true } }),
        tx.driver.findUnique({ where: { userId: user.id }, select: { documentsVerified: true } }),
      ]);
      const ground = type && type.amlRecordClass !== 'NOT_APPLICABLE' ? 'AML_RECORD'
        : doc.status === 'APPROVED' && (vendors > 0 || rider?.documentsVerified || driver?.documentsVerified) ? 'ACTIVE_LICENCE' : null;
      if (ground) throw new AppError(409, ground, 'Document erasure is refused by its current retention obligation');
    }
    const object = doc.fileUrl ? await lockAndResolveSource(tx, { fileKey: doc.fileUrl, userId: user.id, documentId: doc.id }, namespace) : null;
    const prior = !object && doc.imageCompletionClaimId
      ? await tx.documentPurgeClaim.findUnique({ where: { id: doc.imageCompletionClaimId } }) : null;
    if (!object && (!prior || prior.state !== 'COMPLETE' || prior.documentId !== doc.id) && doc.imageSourceKind !== 'BORN_EMPTY') throw verificationObjectUnavailable();
    const runs = mode === 'FULL_ERASURE' ? await tx.extractionRun.findMany({ where: { submissionId: doc.id }, orderBy: { id: 'asc' }, select: { id: true } }) : [];
    const fields = mode === 'FULL_ERASURE' ? await tx.extractedField.findMany({ where: { submissionId: doc.id }, orderBy: { id: 'asc' }, select: { id: true } }) : [];
    const claim = await tx.documentPurgeClaim.create({ data: {
      tenantId: user.tenantId, userId: user.id, documentId: doc.id, subjectId: doc.subjectId, docType: doc.docType, role: doc.role,
      mode, sourceKind: object ? 'OBJECT' : prior ? 'PRIOR_IMAGE' : 'BORN_EMPTY',
      sourceId: object?.sourceId, fileKey: object?.fileKey, storageNamespace: object?.storageNamespace,
      sourceFingerprint: object ? fingerprint(object) : null, sha256: object?.sha256, sizeBytes: object?.sizeBytes,
      previousImageClaimId: prior?.id, runIds: runs.map((r) => r.id), fieldIds: fields.map((f) => f.id), initiatedBy: input.initiatedBy,
    } });
    if (object) await tx.encryptedObject.update({ where: { sourceId: object.sourceId }, data: { retiredClaimId: claim.id } });
    await tx.verificationDocument.update({ where: { id: doc.id }, data: { activePurgeClaimId: claim.id } });
    await purgeEvent(tx, { tenantId: claim.tenantId, userId: user.id, claimId: claim.id, kind: 'PURGE_COMMITTED', actorId: input.initiatedBy, details: { documentId: doc.id, mode } });
    return claim;
  });
}

function missing(error: unknown) {
  const e = error as { code?: string; name?: string } | null;
  return e?.code === 'ENOENT' || e?.name === 'NoSuchKey' || e?.name === 'NotFound';
}

/** Accept only an ID, and reload through a root client AFTER acquisition commits.
 * A transaction client, caller snapshot, or expiring worker token is not authority. */
export async function probeCommittedPurge(db: PrismaClient, storage: PurgeStorage, claimId: string, tenantId: string): Promise<PurgeEvidence> {
  if (typeof db.$transaction !== 'function') throw verificationObjectUnavailable();
  assertPurgeTenant(tenantId);
  const claim = await db.documentPurgeClaim.findFirst({ where: { id: claimId, tenantId } });
  if (!claim) throw verificationObjectUnavailable();
  if (claim.sourceKind !== 'OBJECT') {
    if (claim.sourceKind === 'PRIOR_IMAGE') {
      const prior = await db.documentPurgeClaim.findFirst({ where: { id: claim.previousImageClaimId!, tenantId, documentId: claim.documentId, state: 'COMPLETE' } });
      const receipt = prior && await db.deletionReceipt.findUnique({ where: { purgeClaimId: prior.id } });
      if (!receipt || !['CONFIRMED_ABSENT', 'NOT_APPLICABLE'].includes(receipt.verificationProbeResult)) throw verificationObjectUnavailable();
    }
    const evidence: PurgeEvidence = { sha256: null, bytesDeleted: 0n, storeLocations: [], probe: 'NOT_APPLICABLE' };
    observed.set(evidence, { claimId, tenantId });
    return evidence;
  }
  if (await namespaceOf(storage) !== claim.storageNamespace) throw verificationObjectUnavailable();
  const source = await db.encryptedObject.findUnique({ where: { sourceId: claim.sourceId! } });
  if (!source || source.retiredClaimId !== claim.id || fingerprint(source) !== claim.sourceFingerprint) throw verificationObjectUnavailable();
  const fileKey = claim.fileKey!;
  const evidence: PurgeEvidence = { sha256: Buffer.from(claim.sha256!, 'hex'), bytesDeleted: BigInt(claim.sizeBytes!), storeLocations: [`storage:${fileKey}`, `encrypted_object:${source.sourceId}`], probe: 'FAILED' };
  // A pre-read detects adapter failures, but is never used as the success probe.
  try { await storage.getObject(fileKey); } catch (err) {
    if (!missing(err)) {
      await purgeEvent(db, { tenantId, userId: claim.userId, claimId, kind: 'PROBE_FAILED', actorId: 'purge-worker' });
      return evidence;
    }
  }
  await storage.delete(fileKey).catch(() => undefined);
  await db.$transaction(async (tx) => {
    await lockPurgeUser(tx, claim.userId, claim.tenantId);
    if (claim.documentId) await lockDocumentSource(tx, claim.documentId, claim.userId);
    const shredded = await tx.encryptedObject.updateMany({
      where: { sourceId: claim.sourceId!, retiredClaimId: claim.id, fileKey, wrappedDek: { not: null } },
      data: { wrappedDek: null, shreddedAt: new Date() },
    });
    await purgeEvent(tx, { tenantId, userId: claim.userId, claimId, kind: 'IMAGE_KEY_CHECKED', actorId: 'purge-worker', details: { shredded: shredded.count === 1 } });
  });
  const absent = await storage.getObject(fileKey).then(() => false).catch(missing);
  const key = await db.encryptedObject.findUnique({ where: { sourceId: claim.sourceId! } }).catch(() => null);
  evidence.probe = absent && key?.retiredClaimId === claim.id && key.wrappedDek === null && key.shreddedAt !== null ? 'CONFIRMED_ABSENT' : 'FAILED';
  await purgeEvent(db, { tenantId, userId: claim.userId, claimId, kind: evidence.probe === 'FAILED' ? 'PROBE_FAILED' : 'STORAGE_ABSENCE_OBSERVED', actorId: 'purge-worker' });
  if (evidence.probe === 'CONFIRMED_ABSENT') observed.set(evidence, { claimId, tenantId });
  return evidence;
}

export async function finishDocumentPurge(db: PrismaClient, claimId: string, tenantId: string, evidence: PurgeEvidence, project: (tx: Tx, userId: string) => Promise<void>): Promise<PurgeOutcome> {
  if (evidence.probe === 'FAILED') return 'PROBE_FAILED';
  const proof = observed.get(evidence);
  if (proof?.claimId !== claimId || proof.tenantId !== tenantId) throw verificationObjectUnavailable();
  return db.$transaction<PurgeOutcome>(async (tx) => {
    const seed = await tx.documentPurgeClaim.findFirst({ where: { id: claimId, tenantId } });
    if (!seed?.documentId) throw verificationObjectUnavailable();
    await lockPurgeUser(tx, seed.userId, tenantId);
    const doc = await lockDocumentSource(tx, seed.documentId, seed.userId);
    const claim = await tx.documentPurgeClaim.findUniqueOrThrow({ where: { id: claimId } });
    if (claim.state === 'COMPLETE') return 'PURGED';
    if (!doc || doc.activePurgeClaimId !== claim.id || doc.legalHoldId) throw verificationObjectUnavailable();
    if (claim.sourceId) {
      const source = await tx.encryptedObject.findUnique({ where: { sourceId: claim.sourceId } });
      if (!source || source.wrappedDek !== null || source.retiredClaimId !== claim.id || fingerprint(source) !== claim.sourceFingerprint) throw verificationObjectUnavailable();
    }
    if (claim.mode === 'FULL_ERASURE') {
      await tx.extractionRun.updateMany({ where: { id: { in: claim.runIds }, submissionId: doc.id, tenantId }, data: { wrappedDek: null } });
      await tx.extractedField.updateMany({ where: { id: { in: claim.fieldIds }, submissionId: doc.id, tenantId }, data: { valueCt: null } });
      if (await tx.extractionRun.count({ where: { submissionId: doc.id, wrappedDek: { not: null } } })
        || await tx.extractedField.count({ where: { submissionId: doc.id, valueCt: { not: null } } })) throw verificationObjectUnavailable();
    }
    const now = new Date();
    await tx.verificationDocument.update({ where: { id: doc.id }, data: {
      fileUrl: '', imagePurgedAt: doc.imagePurgedAt ?? (claim.sourceKind === 'BORN_EMPTY' ? null : now),
      imageCompletionClaimId: doc.imageCompletionClaimId ?? claim.id,
      ...(claim.mode !== 'IMAGE_ONLY' && { purgedAt: doc.purgedAt ?? now }),
      ...(claim.mode === 'FULL_ERASURE' && { fieldsPurgedAt: now }),
    } });
    await writeDeletionReceipt(tx, { submissionId: doc.id, subjectId: claim.userId, tenantId, docTypeCode: claim.docType!, deletedBy: claim.initiatedBy, evidence, purgeClaimId: claim.id, scope: claim.mode });
    await tx.documentPurgeClaim.update({ where: { id: claim.id }, data: { state: 'COMPLETE', completedAt: now } });
    await tx.verificationDocument.update({ where: { id: doc.id }, data: { activePurgeClaimId: null } });
    await purgeEvent(tx, { tenantId, userId: claim.userId, claimId, kind: 'PURGE_COMPLETE', actorId: 'purge-worker', details: { mode: claim.mode, probe: evidence.probe } });
    if (claim.mode !== 'IMAGE_ONLY') await project(tx, claim.userId);
    return 'PURGED';
  });
}

export async function purgeDocumentWithClaim(db: PrismaClient, storage: PurgeStorage, input: Parameters<typeof claimDocumentPurge>[2], project: (tx: Tx, userId: string) => Promise<void>): Promise<PurgeOutcome> {
  const claim = await claimDocumentPurge(db, storage, input);
  if (!claim) return 'NOT_PURGED';
  const evidence = await probeCommittedPurge(db, storage, claim.id, claim.tenantId);
  return finishDocumentPurge(db, claim.id, claim.tenantId, evidence, project);
}

/** An orphan is an obligation, never authority. It competes with attachment
 * under User -> source -> orphan; storage is called only after this commits. */
export async function purgeUnattachedObject(db: PrismaClient, storage: PurgeStorage, orphanId: string): Promise<boolean> {
  const seed = await db.storageOrphan.findUnique({ where: { id: orphanId } });
  if (!seed?.userId || seed.purgedAt) return false;
  assertPurgeTenant(seed.tenantId);
  const namespace = await namespaceOf(storage);
  const claim = await db.$transaction(async (tx) => {
    const user = await lockPurgeUser(tx, seed.userId!, seed.tenantId);
    const existing = await tx.documentPurgeClaim.findFirst({ where: { orphanId, userId: user.id, tenantId: user.tenantId } });
    if (existing) return existing;
    if (await tx.docLegalHold.count({ where: { subjectUserId: user.id, tenantId: user.tenantId, releasedAt: null } })) return null;
    const object = await lockAndResolveSource(tx, { fileKey: seed.key, userId: user.id }, namespace);
    await tx.$queryRaw`SELECT id FROM storage_orphans WHERE id = ${orphanId} FOR UPDATE`;
    const row = await tx.storageOrphan.findUnique({ where: { id: orphanId } });
    if (!row || row.purgedAt || row.key !== seed.key || row.userId !== user.id || row.tenantId !== user.tenantId) return null;
    const result = await tx.documentPurgeClaim.create({ data: {
      tenantId: user.tenantId, userId: user.id, orphanId, mode: 'UNATTACHED_OBJECT', sourceKind: 'OBJECT',
      sourceId: object.sourceId, fileKey: object.fileKey, storageNamespace: namespace, sourceFingerprint: fingerprint(object),
      sha256: object.sha256, sizeBytes: object.sizeBytes, runIds: [], fieldIds: [], initiatedBy: 'orphan-reaper',
    } });
    await tx.encryptedObject.update({ where: { sourceId: object.sourceId }, data: { retiredClaimId: result.id } });
    await purgeEvent(tx, { tenantId: user.tenantId, userId: user.id, claimId: result.id, kind: 'PURGE_COMMITTED', actorId: 'orphan-reaper', details: { mode: result.mode } });
    return result;
  });
  if (!claim) return false;
  const evidence = await probeCommittedPurge(db, storage, claim.id, claim.tenantId);
  if (evidence.probe !== 'CONFIRMED_ABSENT') return false;
  return db.$transaction(async (tx) => {
    await lockPurgeUser(tx, claim.userId, claim.tenantId);
    await tx.$queryRaw`SELECT "sourceId" FROM encrypted_objects WHERE "sourceId" = ${claim.sourceId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM storage_orphans WHERE id = ${orphanId} FOR UPDATE`;
    const current = await tx.documentPurgeClaim.findUniqueOrThrow({ where: { id: claim.id } });
    if (current.state === 'COMPLETE') return true;
    const key = await tx.encryptedObject.findUnique({ where: { sourceId: claim.sourceId! } });
    if (!key || key.wrappedDek !== null || key.retiredClaimId !== claim.id) throw verificationObjectUnavailable();
    await tx.storageOrphan.update({ where: { id: orphanId }, data: { purgedAt: new Date() } });
    await tx.documentPurgeClaim.update({ where: { id: claim.id }, data: { state: 'COMPLETE', completedAt: new Date() } });
    await purgeEvent(tx, { tenantId: claim.tenantId, userId: claim.userId, claimId: claim.id, kind: 'PURGE_COMPLETE', actorId: 'orphan-reaper', details: { mode: claim.mode, probe: evidence.probe } });
    return true;
  });
}
