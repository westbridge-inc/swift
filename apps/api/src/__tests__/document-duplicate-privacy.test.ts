import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { resetKeyProviderForTests } from '../providers/storage/envelope';

const notices = vi.hoisted(() => ({ notify: vi.fn(async () => 1) }));
vi.mock('../modules/notification/notification.service', () => ({
  NotificationService: class {}, notifyAdmins: notices.notify, tenantOfUser: async () => 'tenant-a',
}));
vi.mock('../providers/storage/storage-provider', () => ({
  getStorageProvider: () => ({ upload: async () => ({ url: '/uploads/verification/uploader/own-object.enc' }) }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); resetKeyProviderForTests(); });

describe('MASTER-055 duplicate intake privacy', () => {
  it('returns the same intake contract and confines review signals to platform operators', async () => {
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64'));
    resetKeyProviderForTests();
    let duplicate = false;
    let holderErased = false;
    const bytes = Buffer.from('%PDF-synthetic-document');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const app = {
      prisma: {
        encryptedObject: {
          findMany: vi.fn(async () => duplicate ? [{ createdBy: 'foreign-account', sha256 }] : []),
          create: vi.fn(async () => ({ id: 'own-object' })),
        },
        // [Row 331 (c)] The closure census: an erased holder is no duplicate.
        user: { findMany: vi.fn(async () => holderErased ? [{ id: 'foreign-account', phone: 'deleted:foreign-account' }] : []) },
      }, io: {}, authenticate: vi.fn(),
      get: vi.fn(),
      post: (path: string, _options: unknown, handler: (request: unknown) => Promise<unknown>) => handlers.set(path, handler),
    };
    await verificationRoutes(app as unknown as FastifyInstance);
    const request = { user: { userId: 'uploader' }, file: async () => ({
      filename: 'document.pdf', mimetype: 'application/pdf', toBuffer: async () => bytes,
    }) };
    const ordinary = await handlers.get('/upload')!(request);
    duplicate = true;
    const matching = await handlers.get('/upload')!(request);
    expect(matching).toEqual(ordinary);
    expect(matching).toEqual({ success: true, data: { url: '/uploads/verification/uploader/own-object.enc' } });
    expect(notices.notify).toHaveBeenCalledOnce();
    const notice = notices.notify.mock.calls[0] as unknown as [unknown, unknown, { tenantId: string | null; data: unknown }];
    expect(notice[2].tenantId).toBeNull();
    expect(JSON.stringify(notice[2])).not.toContain('foreign-account');
    expect(notice[2].data).toMatchObject({ kind: 'dup_doc', uploader: 'uploader' });
    // [Row 331 (c)] The same bytes held only by an ERASED account raise no review signal.
    holderErased = true;
    expect(await handlers.get('/upload')!(request)).toEqual(ordinary);
    expect(notices.notify).toHaveBeenCalledOnce();
  });
});
