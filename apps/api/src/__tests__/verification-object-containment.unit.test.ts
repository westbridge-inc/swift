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
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import * as consent from '../modules/legal/consent.service';
import * as declaration from '../modules/vendor/unregistered-declaration';
import * as kyc from '../providers/kyc/kyc-provider';
import { decryptBuffer, getKeyProvider } from '../providers/storage/envelope';
import { DECLARATION_DOC_TYPE } from '../modules/verification/doc-registry';

const storage = vi.hoisted(() => ({
  upload: vi.fn(), getObject: vi.fn(), delete: vi.fn(), getSignedUrl: vi.fn(),
}));
vi.mock('../providers/storage/storage-provider', async (original) => ({ ...await original<object>(), getStorageProvider: () => storage }));
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

// Model the delegates' query contract, including ordered keyset scans. No
// resolver is mocked: both normal and historical references are real rows.
function referencePage(rows: any[], query: any, column: string) {
  const filter = query.where?.[column];
  return rows.filter((r) => (!filter?.in || filter.in.includes(r[column]))
    && (!filter?.gt || r[column] > filter.gt))
    .sort((a, b) => a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0).slice(0, query.take);
}

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
      findMany: vi.fn(async (query: any) => referencePage([...objects.values()], query, 'fileKey')),
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
      findMany: vi.fn(async (query: any) => referencePage(documents.filter((d) =>
        (!query.where?.fileUrl?.in || query.where.fileUrl.in.includes(d.fileUrl))
        && (!query.where?.userId || d.userId === query.where.userId)
        && (query.where?.purgedAt !== null || d['purgedAt'] === null)
        && (query.where?.legalHoldId !== null || d['legalHoldId'] === null)
        && (!query.where?.retentionExpiresAt || d['retentionExpiresAt'] < query.where.retentionExpiresAt.lt)), query, 'id')),
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
      retentionExpiresAt: new Date(0) as Date | null, user: { tenantId: 'tenant-a' } };
    documents.push(doc); return doc;
  };
  storage.getObject.mockResolvedValue(Buffer.from('ciphertext'));
  storage.delete.mockResolvedValue(undefined);
  storage.upload.mockImplementation(async ({ folder }: any) => ({ url: `/uploads/${folder}/${'a'.repeat(16)}.enc` }));
  return { db, people, objects, documents, provider, service, capture, account, poison, log };
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); resetKeyProviderForTests(); });

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
      // Independent avatar cleanup is separately authorized; this negative
      // control has no avatar so every storage side effect remains forbidden.
      h.people.get(A)!.avatar = '';
      h.db.$transaction.mockResolvedValueOnce({ alreadyComplete: false, resweep: true, hold: null });
      action = h.account.deleteAccount(A);
    } else {
      h.db.storageOrphan.findMany.mockResolvedValue([{ id: 'orphan', key: key(B), userId: A }]);
      action = retryStorageOrphans(h.db, storage, h.log);
    }
    if (sink === 'orphan') await expect(action).resolves.toBe(0);
    else if (sink === 'account') await expect(action).resolves.toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE' });
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
  it.each(['document', 'metadata'])('scans past a full first page before granting local %s exclusivity', async (table) => {
    const h = harness(); const doc = h.poison(); doc.fileUrl = key(A);
    const alias = key(A).replace('/subject-a/', '/subject-a/spare/../');
    if (table === 'document') {
      for (let i = 0; i < 100; i++) h.documents.push({ id: `000-${i}`, userId: B, fileUrl: key(B, String(i)) });
      h.documents.push({ id: 'zzz', userId: B, fileUrl: alias });
    } else {
      for (let i = 0; i < 100; i++) { const k = key(`aaa-${i}`); h.objects.set(k, { ...h.objects.get(key(B))!, fileKey: k }); }
      h.objects.set(alias, { ...h.objects.get(key(B))!, fileKey: alias });
    }
    await expect(shredAndProbe(h.db, storage, { fileKey: key(A), userId: A, documentId: doc.id })).rejects.toMatchObject(unavailable);
    const delegate = table === 'document' ? h.db.verificationDocument : h.db.encryptedObject;
    expect(delegate.findMany).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled(); expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('refuses authority if the bounded local census cannot prove completion', async () => {
    const h = harness();
    h.db.verificationDocument.findMany.mockImplementation(async ({ where, take }: any) => {
      expect(take).toBe(100);
      const next = Number(where.id?.gt ?? '0');
      return Array.from({ length: take }, (_, i) => ({ id: String(next + i + 1).padStart(5, '0'), userId: B, fileUrl: key(B) }));
    });
    await expect(resolveVerificationObject(h.db, { fileKey: key(A), userId: A })).rejects.toMatchObject(unavailable);
    expect(h.db.verificationDocument.findMany).toHaveBeenCalledTimes(100);
  });

  const aliases = [
    (k: string) => k.replace('/subject-a/', '/subject-a/./'),
    (k: string) => k.replace('/subject-a/', '/subject-a//'),
    (k: string) => k.replace('/subject-a/', '/subject-a/spare/../'),
    (k: string) => k.slice(1),
    (k: string) => k.slice('/uploads/'.length),
    (k: string) => k + '/.',
  ];
  it.each(['document', 'metadata'].flatMap((table) => aliases.map((alias, i) => ({ table, alias, i }))))('refuses cross-subject physical $table alias $i before any destructive access', async ({ table, alias }) => {
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    const h = harness(); const doc = h.poison(); doc.fileUrl = key(A);
    const otherKey = alias(key(A));
    const local = new LocalStorageProvider() as any;
    expect(local.resolveKey(otherKey)).toBe(local.resolveKey(key(A)));
    if (table === 'document') h.documents.push({ id: 'legacy-b', userId: B, fileUrl: otherKey, user: { tenantId: 'tenant-b' } });
    else h.objects.set(otherKey, { ...h.objects.get(key(A))!, fileKey: otherKey, createdBy: B });
    await expect(shredAndProbe(h.db, storage, { fileKey: key(A), userId: A, documentId: doc.id })).rejects.toMatchObject(unavailable);
    expect(storage.getObject).not.toHaveBeenCalled(); expect(storage.delete).not.toHaveBeenCalled();
    expect(h.db.encryptedObject.updateMany).not.toHaveBeenCalled();
  });

  it.each(['s3', 'r2'])('keeps %s keys literal instead of authorizing a normalized metadata key', async (provider) => {
    vi.stubEnv('STORAGE_PROVIDER', provider);
    const h = harness(); const own = key(A).slice('/uploads/'.length);
    const object = h.objects.get(key(A))!; h.objects.delete(key(A));
    h.objects.set(own, { ...object, fileKey: own });
    for (const alias of aliases) h.documents.push({ id: alias(key(A)), userId: B, fileUrl: alias(key(A)) });
    // One of the aliases is EXACTLY the literal own key and must refuse it.
    await expect(resolveVerificationObject(h.db, { fileKey: own, userId: A })).rejects.toMatchObject(unavailable);
    h.documents.splice(h.documents.findIndex((d) => d.fileUrl === own), 1);
    await expect(resolveVerificationObject(h.db, { fileKey: own, userId: A })).resolves.toMatchObject({ fileKey: own });
    await expect(resolveVerificationObject(h.db, { fileKey: key(A), userId: A })).rejects.toMatchObject(unavailable);
  });

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

describe('review corrections: deletion obligations and retry progress', () => {
  it('HTTP deletion reports 202 and records pending state rather than a completed deletion event', async () => {
    const h = harness();
    h.db.auditLog.create.mockResolvedValue({});
    vi.spyOn(AccountService.prototype, 'deleteAccount').mockResolvedValue({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingDocuments: 1, message: 'Document erasure pending.' });
    const routes = await handlers(h, customerRoutes);
    const reply = { code: vi.fn() };
    const result = await routes.get('delete /account')!({ user: { userId: A } }, reply);
    expect(result).toMatchObject({ success: true, data: { deleted: false, status: 'PENDING_DOCUMENT_ERASURE' } });
    expect(reply.code).toHaveBeenCalledWith(202);
    expect(h.db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ACCOUNT_SELF_DELETION_PENDING' }) }));
  });

  function accountHarness() {
    const h = harness();
    const person = Object.assign(h.people.get(A)!, { phone: 'synthetic-phone', firstName: 'Synthetic', lastName: 'Subject', email: 'subject@example.invalid', roles: ['CUSTOMER'] });
    h.db.user.findUniqueOrThrow = vi.fn(async () => person);
    h.db.user.update.mockImplementation(async ({ data }: any) => { Object.assign(person, data); return person; });
    h.db.serviceProvider.updateMany = vi.fn(async () => ({ count: 0 }));
    for (const name of ['order', 'serviceJob']) h.db[name] = { count: vi.fn(async () => 0) };
    for (const name of ['sosAlert', 'incidentCase', 'evidenceBundle']) h.db[name] = { findMany: vi.fn(async () => []) };
    h.db.platformConfig = { upsert: vi.fn() };
    h.db.verificationDocument.updateMany.mockImplementation(async ({ where, data }: any) => {
      const selected = h.documents.filter((d) => (!where.id || d.id === where.id) && d['purgedAt'] === null
        && (where.legalHoldId && 'not' in where.legalHoldId ? d['legalHoldId'] !== null : where.legalHoldId !== null || d['legalHoldId'] === null));
      for (const d of selected) Object.assign(d, data);
      return { count: selected.length };
    });
    h.db.verificationDocument.update.mockImplementation(async ({ where, data }: any) => {
      const doc = h.documents.find((d) => d.id === where.id)!; Object.assign(doc, data); return doc;
    });
    return { ...h, person };
  }

  it.each(['legacy', 'metadata-missing', 'metadata-outage'])('keeps %s as a pending obligation and completes independent cleanup after real deactivation', async (fault) => {
    const h = accountHarness(); const doc = h.poison();
    doc.fileUrl = fault === 'legacy' ? `/uploads/verification/${A}/legacy.jpg` : key(A);
    doc.retentionExpiresAt = null; doc.user = h.person;
    if (fault === 'metadata-missing') h.objects.delete(key(A));
    if (fault === 'metadata-outage') h.db.encryptedObject.findMany.mockRejectedValue(new Error('metadata offline'));
    const originalPointer = doc.fileUrl;
    await expect(h.account.deleteAccount(A)).resolves.toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingDocuments: 1 });
    expect(h.person).toMatchObject({ status: 'DEACTIVATED', firstName: 'Deleted', email: null, avatar: null, phone: `deleted:${A}` });
    expect(doc).toMatchObject({ purgedAt: null, fileUrl: originalPointer });
    expect(doc.retentionExpiresAt).toBeInstanceOf(Date);
    expect(doc.retentionExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    // The due obligation must commit WITH the account cutoff, before it can
    // lose authentication. Verify actual transaction ordering, not a bypass.
    expect(h.db.verificationDocument.updateMany.mock.invocationCallOrder[0]).toBeLessThan(h.db.user.update.mock.invocationCallOrder[0]);
    for (const table of ['session', 'deviceToken', 'address', 'accountRecovery', 'livenessCheck', 'tripShareToken', 'emergencyContact', 'rideQueueEntry', 'supplyWatch', 'cart']) expect(h.db[table].deleteMany).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(avatar(A));
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(h.db.encryptedObject.updateMany).not.toHaveBeenCalled();
    expect(h.db.deletionReceipt.create).not.toHaveBeenCalled();
    expect(h.db.extractionRun.updateMany).not.toHaveBeenCalled();
  });

  it('reaper progresses past an unproven obligation and later recovers an envelope without user authentication', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
    const h = accountHarness(); const doc = h.poison(); doc.fileUrl = key(A); doc.user = h.person;
    const meta = h.objects.get(key(A))!; h.objects.delete(key(A));
    await expect(h.account.deleteAccount(A)).resolves.toMatchObject({ status: 'PENDING_DOCUMENT_ERASURE' });
    vi.setSystemTime(new Date('2026-09-12T12:00:01Z'));
    const legacy = { ...doc, id: 'old-legacy', fileUrl: `/uploads/verification/${A}/legacy.jpg`, user: h.person };
    h.documents.unshift(legacy);
    h.objects.set(key(A), meta);
    storage.delete.mockClear();
    storage.getObject.mockResolvedValueOnce(Buffer.from('ciphertext')).mockRejectedValueOnce({ code: 'ENOENT' });
    await expect(h.service.purgeExpiredDocuments()).rejects.toMatchObject(unavailable);
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(key(A));
    expect(doc.purgedAt).toBeInstanceOf(Date); expect(doc.fileUrl).toBe('');
    expect(h.db.extractionRun.updateMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { submissionId: doc.id } }));
    expect(h.db.deletionReceipt.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: expect.objectContaining({ submissionId: doc.id, verificationProbeResult: 'CONFIRMED_ABSENT' }) }));
    expect(legacy.purgedAt).toBeNull(); expect(legacy.fileUrl).toContain('legacy.jpg');
    expect(h.db.platformConfig.upsert).not.toHaveBeenCalled(); // partial sweep must still alarm
    await expect(h.service.purgeExpiredDocuments()).rejects.toMatchObject(unavailable);
    expect(storage.delete).toHaveBeenCalledOnce(); // no false retry of a purged document
  });

  it('repeated bounded orphan scans reach eligible tails while retaining failed oldest rows', async () => {
    const h = harness();
    const rows = Array.from({ length: 13 }, (_, i) => ({ id: String(i).padStart(3, '0'), createdAt: new Date(0), purgedAt: null as Date | null, userId: A, key: i < 6 ? avatar(A) + i : key(A, String(i)) }));
    for (const row of rows.slice(6)) h.objects.set(row.key, { ...h.objects.get(key(A))!, fileKey: row.key });
    h.db.storageOrphan.findMany.mockImplementation(async ({ take, where, orderBy, cursor, skip }: any) => {
      expect(take).toBeLessThanOrEqual(5);
      expect(orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
      expect(cursor).toBeUndefined(); expect(skip).toBeUndefined();
      return rows.filter((r) => !r.purgedAt && r.createdAt <= where.createdAt.lte
        && (!where.OR || r.createdAt > where.OR[0].createdAt.gt
          || (r.createdAt.getTime() === where.OR[1].createdAt.getTime() && r.id > where.OR[1].id.gt))).slice(0, take);
    });
    h.db.storageOrphan.update.mockImplementation(async ({ where }: any) => { rows.find((r) => r.id === where.id)!.purgedAt = new Date(); });
    const counts = [];
    for (let run = 0; run < 3; run++) counts.push(await retryStorageOrphans(h.db, storage, h.log));
    expect(counts).toEqual([5, 2, 0]);
    expect(rows.slice(0, 6).every((r) => r.purgedAt === null)).toBe(true);
    expect(rows.slice(6).every((r) => r.purgedAt !== null)).toBe(true);
    expect(storage.delete.mock.calls.map(([k]) => k)).toEqual(rows.slice(6).map((r) => r.key));
  });

  it('a failed storage probe keeps the due pointer and cannot become a successful account purge', async () => {
    const h = accountHarness(); const doc = h.poison(); doc.fileUrl = key(A);
    storage.getObject.mockRejectedValue(new Error('object store offline'));
    await expect(h.account.deleteAccount(A)).resolves.toMatchObject({ deleted: false, status: 'PENDING_DOCUMENT_ERASURE', pendingDocuments: 1 });
    expect(doc).toMatchObject({ purgedAt: null, fileUrl: key(A) });
    expect(h.db.deletionReceipt.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: expect.objectContaining({ verificationProbeResult: 'FAILED' }) }));
    expect(h.db.encryptedObject.updateMany).not.toHaveBeenCalled();
    expect(h.db.session.deleteMany).toHaveBeenCalledOnce();
    expect(h.db.user.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ phone: `deleted:${A}` }) }));
  });
});

describe('generated declaration envelope contract', () => {
  async function declarationHarness(vendorType = 'RESTAURANT') {
    const h = harness(); h.objects.clear();
    const vendor = { id: 'store-a', name: 'Synthetic store', vendorType, tier: 'REGISTERED' };
    h.db.vendor.findUniqueOrThrow = vi.fn(async () => vendor);
    h.db.vendor.update = vi.fn(async ({ data }: any) => Object.assign(vendor, data));
    h.db.user.findUniqueOrThrow = vi.fn(async () => ({ ...h.people.get(A), firstName: 'Synthetic', lastName: 'Subject' }));
    h.db.vendorOwner.findUnique.mockImplementation(async ({ select }: any) => ({ id: 'owner-a', vendors: !select || vendor.tier === 'UNREGISTERED' ? [vendor] : [] }));
    h.db.documentRecord = { findFirst: vi.fn(async () => null) };
    h.db.requirementSet = { findFirst: vi.fn(async () => null) };
    h.db.countryConfig = { findUnique: vi.fn(async () => ({ documentChecklists: {} })) };
    h.db.docType.findMany = vi.fn(async () => []);
    h.db.categoryDocumentGate = { findMany: vi.fn(async () => []) };
    const published = vi.spyOn(consent, 'publishLegalDocumentOnce').mockResolvedValue(undefined as never);
    const signed = vi.spyOn(consent, 'recordConsent').mockResolvedValue(undefined as never);
    const plaintext = Buffer.from('synthetic signed PDF');
    const render = vi.spyOn(declaration, 'renderDeclarationPdf').mockResolvedValue(plaintext);
    vi.spyOn(kyc, 'getKycProvider').mockReturnValue(h.provider as never);
    const prototype = VerificationService.prototype as any;
    for (const name of ['externalProcessingSubject', 'validatorContextFor']) vi.spyOn(prototype, name).mockResolvedValue({});
    vi.spyOn(prototype, 'planExtractionFor').mockResolvedValue({ plan: undefined, type: null });
    vi.spyOn(prototype, 'createDocumentLively').mockImplementation(async (data: any) => {
      await resolveVerificationObject(h.db, { fileKey: data.fileUrl, userId: data.userId });
      const doc = { id: 'declaration-a', ...data }; h.documents.push(doc); return doc;
    });
    vi.spyOn(prototype, 'recordDecision').mockResolvedValue(undefined);
    vi.spyOn(prototype, 'getStatus').mockResolvedValue({ required: [DECLARATION_DOC_TYPE] });
    const routes = await handlers(h, vendorRoutes);
    const reply = { code: vi.fn() };
    const invoke = () => routes.get('post /onboarding/declaration')!({ user: { userId: A }, headers: { 'x-vendor-id': vendor.id }, ip: '127.0.0.1', body: {
      tradingName: 'Synthetic store', activityClass: 'home_cook', declaredAddress: 'Synthetic address', attestationVersion: declaration.DECLARATION_VERSION,
    } }, reply);
    return { ...h, vendor, published, signed, render, plaintext, invoke, reply };
  }

  it.each(['', 'invalid'])('no usable KEK (%s) refuses before legal publish, tier, consent, rendering or storage', async (keyValue) => {
    vi.stubEnv('MASTER_KEK', keyValue); resetKeyProviderForTests();
    const h = await declarationHarness();
    await expect(h.invoke()).rejects.toMatchObject({ code: 'VERIFICATION_UPLOAD_UNAVAILABLE', statusCode: 503 });
    expect(h.vendor.tier).toBe('REGISTERED');
    for (const sideEffect of [h.published, h.signed, h.render, h.db.vendor.update, storage.upload, h.db.encryptedObject.create, h.provider.verifyDocument]) expect(sideEffect).not.toHaveBeenCalled();
    expect(h.documents).toHaveLength(0);
  });

  it('unsupported SERVICE declaration refuses before side effects without inventing a checklist', async () => {
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64')); resetKeyProviderForTests();
    const h = await declarationHarness('SERVICE');
    await expect(h.invoke()).rejects.toMatchObject({ code: 'DECLARATION_UNSUPPORTED' });
    expect(h.vendor.tier).toBe('REGISTERED');
    for (const sideEffect of [h.published, h.signed, h.render, h.db.vendor.update, storage.upload, h.db.encryptedObject.create]) expect(sideEffect).not.toHaveBeenCalled();
    expect(h.documents).toHaveLength(0);
  });

  it('the owned encrypted declaration is decryptable and accepted by real intake', async () => {
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64')); resetKeyProviderForTests();
    const h = await declarationHarness();
    await expect(h.invoke()).resolves.toMatchObject({ success: true, data: { tier: 'UNREGISTERED', declaration: { status: 'PENDING', docType: DECLARATION_DOC_TYPE } } });
    expect(h.reply.code).toHaveBeenCalledWith(201);
    expect(h.published).toHaveBeenCalledOnce(); expect(h.signed).toHaveBeenCalledOnce();
    expect(h.provider.verifyDocument).toHaveBeenCalledWith(expect.objectContaining({ userId: A, fileUrl: key(A) }));
    const meta = h.objects.get(key(A))!;
    const uploaded = storage.upload.mock.calls[0]![0];
    expect(uploaded.mimeType).toBe('application/octet-stream');
    expect(uploaded.buffer.equals(h.plaintext)).toBe(false);
    const dek = await getKeyProvider()!.unwrapDek(Buffer.from(meta.wrappedDek!));
    expect(decryptBuffer(uploaded.buffer, dek, Buffer.from(meta.iv), Buffer.from(meta.authTag))).toEqual(h.plaintext);
    expect(meta.createdBy).toBe(A); expect(h.documents).toHaveLength(1);
  });

  it('an unavailable wrapping service fails before declaration side effects', async () => {
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64')); resetKeyProviderForTests();
    vi.spyOn(getKeyProvider()!, 'wrapDek').mockRejectedValue(new Error('key service offline'));
    const h = await declarationHarness();
    await expect(h.invoke()).rejects.toMatchObject({ code: 'VERIFICATION_UPLOAD_UNAVAILABLE', statusCode: 503 });
    for (const sideEffect of [h.published, h.signed, h.render, h.db.vendor.update, storage.upload, h.db.encryptedObject.create]) expect(sideEffect).not.toHaveBeenCalled();
  });
});
