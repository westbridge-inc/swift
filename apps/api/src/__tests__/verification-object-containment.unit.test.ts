import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerificationService } from '../modules/verification/verification.service';
import { AccountService } from '../modules/user/account.service';
import { eraseDocumentsFor } from '../modules/verification/dsar';
import { retryStorageOrphans } from '../lib/storage-orphans';
import type { NotificationService } from '../modules/notification/notification.service';
import { resolveSignupSelfie, resolveVerificationObject } from '../modules/verification/object-authority';
import { shredAndProbe } from '../modules/verification/purge-receipt';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { mintRenderPath, resetKeyProviderForTests } from '../providers/storage/envelope';

const storage = vi.hoisted(() => ({
  upload: vi.fn(), getObject: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn(),
}));
vi.mock('../providers/storage/storage-provider', () => ({ getStorageProvider: () => storage }));
vi.mock('../modules/notification/notification.service', () => ({
  NotificationService: class {}, notifyAdmins: vi.fn(), tenantOfUser: vi.fn(async () => 'tenant-a'),
}));
vi.mock('../modules/user/partner-wind-down', () => ({ windDownPartner: vi.fn(async () => null) }));

const A = 'subject-a';
const B = 'subject-b';
const key = (owner: string, name = 'a') => `/uploads/verification/${owner}/${name.repeat(16)}.enc`;
const avatar = (owner: string) => `/uploads/avatars/${owner}/${'s'.repeat(16)}.jpg`;
const unavailable = { code: 'VERIFICATION_OBJECT_UNAVAILABLE' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const uploadRequest = (userId: string) => ({ user: { userId }, file: async () => ({
  mimetype: 'image/png', filename: 'image.png', toBuffer: async () => png,
}) });

function harness() {
  const people = new Map([A, B].map((id) => [id, {
    id, tenantId: id === A ? 'tenant-a' : 'tenant-b', countryCode: 'GY', trustLevel: 'L1',
    status: 'ACTIVE', avatar: avatar(id), selfieCapturedAt: new Date(),
  }]));
  const objects = new Map([A, B].map((id) => [key(id), {
    fileKey: key(id), createdBy: id, wrappedDek: new Uint8Array(60).fill(1),
    shreddedAt: null as Date | null, iv: new Uint8Array(12), authTag: new Uint8Array(16),
    sha256: 'a'.repeat(64), sizeBytes: 1, mimeType: 'image/jpeg', createdAt: new Date(),
  }]));
  const documents: Array<{ id: string; userId: string; fileUrl: string } & Record<string, any>> = [];
  const db: any = {
    user: { findUnique: vi.fn(async ({ where }: any) => people.get(where.id)), update: vi.fn(), findMany: vi.fn(async () => []) },
    encryptedObject: {
      findUnique: vi.fn(async ({ where }: any) => objects.get(where.fileKey) ?? null),
      findMany: vi.fn(async ({ where }: any) => [...objects.values()].filter((o) => where.fileKey.in.includes(o.fileKey))),
      findFirst: vi.fn(async () => null), updateMany: vi.fn(async ({ where }: any) => {
        const object = objects.get(where.fileKey);
        if (object) { (object as any).wrappedDek = null; object.shreddedAt = new Date(); }
        return { count: object ? 1 : 0 };
      }),
      create: vi.fn(async ({ data }: any) => { objects.set(data.fileKey, { ...data, shreddedAt: null, createdAt: new Date() }); }),
    },
    verificationDocument: {
      findUnique: vi.fn(async ({ where }: any) => documents.find((d) => d.id === where.id)),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: any) => documents.filter((d) =>
        (!where.fileUrl || where.fileUrl.in.includes(d.fileUrl)) && (!where.userId || d.userId === where.userId))),
      create: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })),
    },
    storageOrphan: { findMany: vi.fn(async () => []), update: vi.fn(), upsert: vi.fn() },
    auditLog: { create: vi.fn() }, deletionReceipt: { create: vi.fn(), findFirst: vi.fn() },
    vendor: { count: vi.fn(async () => 0) }, rider: { findUnique: vi.fn(async () => null) }, driver: { findUnique: vi.fn(async () => null) },
    serviceProvider: { findUnique: vi.fn(async () => null) }, vendorOwner: { findUnique: vi.fn(async () => null) },
    docType: { findUnique: vi.fn(async () => null) },
    advertiserMember: { findMany: vi.fn(async () => []), deleteMany: vi.fn() }, vendorStaff: { deleteMany: vi.fn() },
    extractionRun: { updateMany: vi.fn() }, extractedField: { updateMany: vi.fn() },
    integritySettings: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(db)),
    $queryRaw: vi.fn(async () => [{ id: A, status: 'ACTIVE', tenantId: 'tenant-a', countryCode: 'GY' }]),
  };
  for (const name of ['faceTemplate', 'identityKey', 'identityClusterMember', 'session', 'deviceToken', 'address', 'accountRecovery', 'livenessCheck', 'tripShareToken', 'emergencyContact', 'rideQueueEntry', 'supplyWatch', 'cart']) {
    db[name] = { deleteMany: vi.fn() };
  }
  const provider = {
    engine: { name: 'test', version: '1', external: false },
    verifyDocument: vi.fn(async () => ({ status: 'pending_manual' as const, referenceToken: 'test' })),
    verifyIdentity: vi.fn(async () => ({ status: 'pending_manual' as const, referenceToken: 'test' })),
    getStatus: vi.fn(async () => 'pending_manual' as const),
  };
  const service = new VerificationService(db as PrismaClient, {} as NotificationService, provider);
  const internals = service as any;
  vi.spyOn(internals, 'moverSubmittableChecklist').mockResolvedValue(['vehicle_registration', 'national_id']);
  vi.spyOn(internals, 'externalProcessingSubject').mockResolvedValue({});
  vi.spyOn(internals, 'validatorContextFor').mockResolvedValue({});
  vi.spyOn(internals, 'planExtractionFor').mockResolvedValue({ plan: undefined, type: null });
  vi.spyOn(internals, 'createDocumentLively').mockImplementation(async (data: any) => {
    db.verificationDocument.create(data); return { id: 'created', ...data };
  });
  vi.spyOn(internals, 'recordDecision').mockResolvedValue(undefined);
  const capture = vi.spyOn(internals, 'holdOnCrossSubjectCollision');
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const account = new AccountService({ prisma: db, log, io: {} } as unknown as FastifyInstance);
  const poison = () => {
    const doc = { id: 'poison', userId: A, fileUrl: key(B), docType: 'vehicle_registration',
      state: 'COMMITTED', status: 'REJECTED', legalHoldId: null, imagePurgedAt: null, purgedAt: null,
      retentionExpiresAt: new Date(0), user: { tenantId: 'tenant-a' } };
    documents.push(doc); return doc;
  };
  storage.getObject.mockResolvedValue(Buffer.from('ciphertext'));
  storage.delete.mockResolvedValue(undefined);
  storage.upload.mockImplementation(async ({ folder }: any) => ({ url: `/uploads/${folder}/${'a'.repeat(16)}.enc` }));
  return { db, people, objects, documents, provider, service, capture, account, poison, log };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); resetKeyProviderForTests(); });

// Execute the real route handlers over an in-memory database. Auth/admin hooks
// are not the subject of these tests; the input principal is explicitly bound.
async function handlers(h: ReturnType<typeof harness>, routes: typeof verificationRoutes) {
  const registered = new Map<string, (...args: any[]) => any>();
  const app: any = { prisma: h.db, io: {}, log: h.log, prefix: '', addHook: vi.fn() };
  h.db.$extends = () => h.db;
  for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
    app[verb] = (path: string, ...args: any[]) => { registered.set(`${verb} ${path}`, args.at(-1)); };
  }
  await routes(app);
  return registered;
}

describe('verification object containment at real service boundaries', () => {
  it.each(['same-tenant', 'cross-tenant'].flatMap((tenancy) => ['checklist', 'id', 'selfie'].map((input) => [tenancy, input])))('%s B upload cannot enter A %s processing', async (tenancy, input) => {
    const h = harness();
    if (tenancy === 'same-tenant') h.people.get(B)!.tenantId = 'tenant-a';
    // B really uploads through the existing handler before A supplies its key.
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64')); resetKeyProviderForTests();
    const routes = await handlers(h, verificationRoutes);
    h.objects.delete(key(B));
    await routes.get('post /upload')!(uploadRequest(B));
    expect(h.db.encryptedObject.create).toHaveBeenCalledOnce();
    const attempt = input === 'checklist' ? h.service.submitDocument(A, 'MOVER', 'vehicle_registration', key(B), '1')
      : h.service.submitIdentity(A, key(input === 'id' ? B : A), key(input === 'selfie' ? B : A), '1');
    await expect(attempt).rejects.toMatchObject(unavailable);
    expect(h.provider.verifyDocument).not.toHaveBeenCalled();
    expect(h.provider.verifyIdentity).not.toHaveBeenCalled();
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.db.verificationDocument.create).not.toHaveBeenCalled();
  });

  it.each(['dsar', 'retention', 'image', 'account', 'orphan'])('poisoned legacy pointer cannot reach the %s storage sink', async (sink) => {
    const h = harness(); const doc = h.poison();
    let action: Promise<unknown>;
    if (sink === 'dsar') action = eraseDocumentsFor(h.db, h.service, A);
    else if (sink === 'retention') action = h.service.purgeExpiredDocuments();
    else if (sink === 'image') action = h.service.purgeImageAfterReview(doc.id, A);
    else if (sink === 'account') {
      h.db.$transaction.mockResolvedValueOnce({ alreadyComplete: false, resweep: true, hold: null });
      action = h.account.deleteAccount(A);
    } else {
      h.db.storageOrphan.findMany.mockResolvedValue([{ id: 'orphan', key: key(B), userId: A }]);
      action = retryStorageOrphans(h.db, storage, h.log);
    }
    if (sink === 'orphan') await expect(action).resolves.toBe(0);
    else await expect(action).rejects.toMatchObject(unavailable);
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.db.encryptedObject.updateMany).not.toHaveBeenCalled();
    expect(h.db.verificationDocument.update).not.toHaveBeenCalled();
    expect(h.db.deletionReceipt.create).not.toHaveBeenCalled();
    expect(h.db.storageOrphan.update).not.toHaveBeenCalled();
  });

  it.each(['mint', 'render'])('poisoned document cannot reach admin %s dereference', async (operation) => {
    const h = harness(); const doc = h.poison();
    const routes = await handlers(h, operation === 'mint' ? adminRoutes : verificationRoutes);
    const path = mintRenderPath(doc.id).path;
    const query = Object.fromEntries(new URL(path, 'http://localhost').searchParams);
    const invoke = operation === 'mint'
      ? routes.get('get /verification/:id/document-url')!({ params: { id: doc.id }, user: { userId: 'reviewer' } })
      : routes.get('get /render/:docId')!({ params: { docId: doc.id }, query }, {});
    await expect(invoke).rejects.toMatchObject(unavailable);
    expect(storage.getSignedUrl).not.toHaveBeenCalled(); expect(storage.getObject).not.toHaveBeenCalled();
    expect(h.db.auditLog.create).not.toHaveBeenCalled();
  });

  it('owned encrypted upload can mint and render the original image', async () => {
    const h = harness();
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64')); resetKeyProviderForTests();
    const routes = await handlers(h, verificationRoutes);
    storage.upload.mockImplementationOnce(async ({ buffer }: any) => {
      storage.getObject.mockResolvedValue(buffer); return { url: key(A) };
    });
    await routes.get('post /upload')!(uploadRequest(A));
    const doc = h.poison(); doc.fileUrl = key(A);
    const admin = await handlers(h, adminRoutes);
    const minted = await admin.get('get /verification/:id/document-url')!({ params: { id: doc.id }, user: { userId: 'reviewer' } });
    const query = Object.fromEntries(new URL(minted.data.url, 'http://localhost').searchParams);
    const reply: any = { type: vi.fn().mockReturnThis(), header: vi.fn().mockReturnThis(), send: vi.fn() };
    await routes.get('get /render/:docId')!({ params: { docId: doc.id }, query }, reply);
    expect(reply.send).toHaveBeenCalledWith(png);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
    expect(h.db.auditLog.create).toHaveBeenCalledOnce();
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it('missing encryption configuration refuses upload before storing plaintext', async () => {
    const h = harness(); vi.stubEnv('MASTER_KEK', ''); resetKeyProviderForTests();
    const routes = await handlers(h, verificationRoutes);
    await expect(routes.get('post /upload')!(uploadRequest(A))).rejects.toMatchObject({ code: 'VERIFICATION_UPLOAD_UNAVAILABLE' });
    expect(storage.upload).not.toHaveBeenCalled(); expect(h.db.encryptedObject.create).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'missing-storage', 'storage-error', 'invalid-envelope'])('admin render fails closed on %s without exposing storage errors', async (fault) => {
    const h = harness(); const doc = h.poison(); doc.fileUrl = key(A);
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64')); resetKeyProviderForTests();
    if (fault === 'metadata') h.db.encryptedObject.findMany.mockRejectedValue(new Error('private metadata error'));
    if (fault === 'missing-storage') storage.getObject.mockRejectedValue({ code: 'ENOENT' });
    if (fault === 'storage-error') storage.getObject.mockRejectedValue(new Error('private storage error'));
    const routes = await handlers(h, verificationRoutes);
    const query = Object.fromEntries(new URL(mintRenderPath(doc.id).path, 'http://localhost').searchParams);
    const reply = { send: vi.fn() };
    await expect(routes.get('get /render/:docId')!({ params: { docId: doc.id }, query }, reply)).rejects.toMatchObject({ ...unavailable, message: 'This verification file is unavailable. Upload it again.' });
    expect(reply.send).not.toHaveBeenCalled();
    if (fault === 'metadata') expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('owned unclaimed upload reaches the checklist provider and document write', async () => {
    const h = harness();
    await expect(h.service.submitDocument(A, 'MOVER', 'vehicle_registration', key(A), '1')).resolves.toMatchObject({ userId: A, fileUrl: key(A) });
    expect(h.provider.verifyDocument).toHaveBeenCalledOnce();
    expect(h.db.verificationDocument.create).toHaveBeenCalledOnce();
  });

  it('owned identity and owned selfie uploads reach the identity provider', async () => {
    const h = harness(); vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', '1');
    const selfie = key(A, 's'); h.objects.set(selfie, { ...h.objects.get(key(A))!, fileKey: selfie });
    await expect(h.service.submitIdentity(A, key(A), selfie, '1')).resolves.toMatchObject({ userId: A, fileUrl: key(A) });
    expect(h.provider.verifyIdentity).toHaveBeenCalledWith({ userId: A, idDocumentUrl: key(A), selfieUrl: selfie });
  });

  it('server-persisted signup selfie keeps the checklist face-match path working', async () => {
    const h = harness(); vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', '1');
    await h.service.submitDocument(A, 'MOVER', 'national_id', key(A), '1');
    expect(h.provider.verifyIdentity).toHaveBeenCalledWith({ userId: A, idDocumentUrl: key(A), selfieUrl: avatar(A) });
  });

  it.each([avatar(B), key(B), key(A), 'https://example.invalid/photo.jpg', '/uploads/avatars/subject-a/../subject-b/ssssssssssssssss.jpg'])('poisoned persisted signup selfie %s is refused with a retake instruction', async (value) => {
    const h = harness(); h.people.get(A)!.avatar = value; vi.stubEnv('FEATURE_BIOMETRIC_FACE_MATCH', '1');
    await expect(h.service.submitDocument(A, 'MOVER', 'national_id', key(A), '1')).rejects.toMatchObject({ code: 'SELFIE_REQUIRED' });
    expect(h.provider.verifyIdentity).not.toHaveBeenCalled();
    await expect(resolveSignupSelfie(h.db, A)).rejects.toThrow('Retake your profile selfie');
  });

  it('poisoned account avatar cannot delete a verification object', async () => {
    const h = harness(); h.people.get(A)!.avatar = key(B);
    h.db.$transaction.mockResolvedValueOnce({ alreadyComplete: false, resweep: true, hold: null });
    await h.account.deleteAccount(A);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(h.db.storageOrphan.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ key: key(B), userId: A, reason: 'ACCOUNT_AVATAR_AUTHORITY_UNPROVEN' }) }));
  });

  it.each([key(B), avatar(B), avatar(A)])('signup selfie replacement only deletes the subject-owned avatar (%s)', async (prior) => {
    const h = harness(); h.people.get(A)!.avatar = prior;
    const next = avatar(A).replace('ssssssssssssssss', 'nnnnnnnnnnnnnnnn');
    storage.upload.mockResolvedValueOnce({ url: next });
    h.db.user.updateMany = vi.fn(async () => ({ count: 1 }));
    h.db.user.findUniqueOrThrow = vi.fn(async () => ({ ...h.people.get(A), avatar: next }));
    const routes = await handlers(h, authRoutes);
    await routes.get('post /selfie')!(uploadRequest(A), { send: vi.fn() });
    expect(h.db.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: A }), data: expect.objectContaining({ avatar: next }) }));
    if (prior === avatar(A)) expect(storage.delete).toHaveBeenCalledWith(prior);
    else {
      expect(storage.delete).not.toHaveBeenCalled();
      expect(h.db.storageOrphan.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ key: prior, userId: A, reason: 'REPLACED_SELFIE_AUTHORITY_UNPROVEN' }) }));
    }
  });

  it.each(['dsar', 'retention', 'image', 'account'])('owned single document succeeds through the %s sink and preserves image/full-record semantics', async (sink) => {
    const h = harness(); const doc = h.poison(); doc.fileUrl = key(A);
    h.db.verificationDocument.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(doc, data); return { count: 1 };
    });
    h.db.verificationDocument.update.mockImplementation(async ({ data }: any) => { Object.assign(doc, data); return doc; });
    storage.getObject.mockResolvedValueOnce(Buffer.from('ciphertext')).mockRejectedValueOnce({ code: 'ENOENT' });
    if (sink === 'dsar') expect(await eraseDocumentsFor(h.db, h.service, A)).toEqual([expect.objectContaining({ outcome: 'DESTROYED' })]);
    else if (sink === 'retention') {
      // The reaper heartbeat is unrelated to object authority.
      h.db.platformConfig = { upsert: vi.fn() };
      await h.service.purgeExpiredDocuments();
    } else if (sink === 'image') expect(await h.service.purgeImageAfterReview(doc.id, A)).toBe('PURGED');
    else {
      h.db.$transaction.mockResolvedValueOnce({ alreadyComplete: false, resweep: true, hold: null });
      await h.account.deleteAccount(A);
    }
    expect(storage.delete).toHaveBeenCalledWith(key(A));
    expect(h.db.deletionReceipt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ verificationProbeResult: 'CONFIRMED_ABSENT' }) }));
    if (sink === 'image') {
      expect(doc.imagePurgedAt).toBeInstanceOf(Date); expect(doc.purgedAt).toBeNull();
      expect(h.db.extractionRun.updateMany).not.toHaveBeenCalled();
    } else expect(doc.purgedAt).toBeInstanceOf(Date);
    if (sink === 'dsar' || sink === 'account') expect(h.db.extractionRun.updateMany).toHaveBeenCalledOnce();
  });

  it('document creation rechecks ownership before subject/extraction writes', async () => {
    const h = harness();
    (h.service as any).createDocumentLively.mockRestore();
    await expect((h.service as any).createDocumentLively({ userId: A, fileUrl: key(B), docType: 'national_id', role: 'CUSTOMER' })).rejects.toMatchObject(unavailable);
    expect(h.db.verificationDocument.create).not.toHaveBeenCalled();
  });

  it.each([undefined, A])('unbound/public orphan remains open without deletion authority (%s)', async (userId) => {
    const h = harness(); h.db.storageOrphan.findMany.mockResolvedValue([{ id: 'orphan', key: avatar(A), userId }]);
    expect(await retryStorageOrphans(h.db, storage, h.log)).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled(); expect(h.db.storageOrphan.update).not.toHaveBeenCalled();
  });

  it('an owned unclaimed envelope orphan can retry after revalidation', async () => {
    const h = harness(); h.db.storageOrphan.findMany.mockResolvedValue([{ id: 'orphan', key: key(A), userId: A }]);
    expect(await retryStorageOrphans(h.db, storage, h.log)).toBe(1);
    expect(storage.delete).toHaveBeenCalledWith(key(A)); expect(h.db.storageOrphan.update).toHaveBeenCalledOnce();
  });
});

describe('existing metadata authority fails closed', () => {
  it('accepts the exact owned private-store key and rejects a shared local alias', async () => {
    const h = harness(); const local = key(A); const relative = local.slice('/uploads/'.length);
    const object = h.objects.get(local)!; h.objects.delete(local); h.objects.set(relative, { ...object, fileKey: relative });
    await expect(resolveVerificationObject(h.db, { fileKey: relative, userId: A })).resolves.toMatchObject({ createdBy: A });
    h.documents.push({ id: 'legacy', userId: B, fileUrl: `uploads/${relative}` });
    await expect(resolveVerificationObject(h.db, { fileKey: relative, userId: A })).rejects.toMatchObject(unavailable);
  });

  it.each([avatar(A), 'https://example.invalid/document', `/uploads/verification/${A}/../${B}/${'a'.repeat(16)}.enc`,
    key(A) + '?x=1', key(A) + '#x', key(A).replace('/verification/', '/verification//'),
    key(A).replace('aaaaaaaaaaaaaaaa', '%61aaaaaaaaaaaaaaa'), key(A).replace('.enc', '.jpg')])('rejects non-envelope or non-canonical key %s before metadata/storage access', async (fileKey) => {
    const h = harness();
    await expect(resolveVerificationObject(h.db, { fileKey, userId: A })).rejects.toMatchObject(unavailable);
    expect(h.db.encryptedObject.findMany).not.toHaveBeenCalled();
  });

  it.each(['missing', 'foreign-creator', 'shredded', 'missing-dek', 'invalid-iv', 'invalid-hash', 'metadata-error', 'reference-error', 'shared-same-user', 'shared-other-user', 'alias-metadata'])('rejects %s proof without existence disclosure', async (fault) => {
    const h = harness(); const object = h.objects.get(key(A))!;
    if (fault === 'missing') h.objects.clear();
    if (fault === 'foreign-creator') object.createdBy = B;
    if (fault === 'shredded') object.shreddedAt = new Date();
    if (fault === 'missing-dek') (object as any).wrappedDek = null;
    if (fault === 'invalid-iv') object.iv = new Uint8Array(0);
    if (fault === 'invalid-hash') object.sha256 = 'invalid';
    if (fault === 'metadata-error') h.db.encryptedObject.findMany.mockRejectedValue(new Error('private metadata failure'));
    if (fault === 'reference-error') h.db.verificationDocument.findMany.mockRejectedValue(new Error('private metadata failure'));
    if (fault.startsWith('shared')) h.documents.push({ id: 'legacy', userId: fault === 'shared-same-user' ? A : B, fileUrl: key(A) });
    if (fault === 'alias-metadata') {
      const alias = key(A).slice('/uploads/'.length); h.objects.set(alias, { ...object, fileKey: alias });
    }
    await expect(resolveVerificationObject(h.db, { fileKey: key(A), userId: A })).rejects.toMatchObject({
      ...unavailable, message: 'This verification file is unavailable. Upload it again.',
    });
  });

  it('owned single submission can purge; another reference prevents its destructive read', async () => {
    const h = harness(); const doc = h.poison(); doc.fileUrl = key(A);
    h.db.verificationDocument.findMany.mockResolvedValue([doc, { id: 'other', userId: B, fileUrl: key(A) }]);
    await expect(shredAndProbe(h.db, storage, { fileKey: key(A), userId: A, documentId: doc.id })).rejects.toMatchObject(unavailable);
    expect(storage.getObject).not.toHaveBeenCalled();
    h.db.verificationDocument.findMany.mockResolvedValue([doc]);
    storage.getObject.mockResolvedValueOnce(Buffer.from('ciphertext')).mockRejectedValueOnce({ code: 'ENOENT' });
    const result = await shredAndProbe(h.db, storage, { fileKey: key(A), userId: A, documentId: doc.id });
    expect(result.probe).toBe('CONFIRMED_ABSENT'); expect(storage.delete).toHaveBeenCalledWith(key(A));
    expect(h.objects.get(key(A))!.wrappedDek).toBeNull();
  });

  it.each(['before-read', 'after-read', 'after-metadata'])('%s failure cannot produce a passing purge receipt', async (fault) => {
    const h = harness(); const doc = h.poison(); doc.fileUrl = key(A);
    if (fault === 'before-read') storage.getObject.mockRejectedValue(new Error('storage unavailable'));
    else storage.getObject.mockResolvedValueOnce(Buffer.from('ciphertext')).mockRejectedValueOnce(fault === 'after-read' ? new Error('storage unavailable') : { code: 'ENOENT' });
    if (fault === 'after-metadata') h.db.encryptedObject.findUnique.mockRejectedValue(new Error('metadata unavailable'));
    const result = await shredAndProbe(h.db, storage, { fileKey: key(A), userId: A, documentId: doc.id });
    expect(result.probe).toBe('FAILED');
    if (fault === 'before-read') expect(storage.delete).not.toHaveBeenCalled();
  });
});
