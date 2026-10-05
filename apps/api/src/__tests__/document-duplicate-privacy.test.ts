import type { FastifyInstance } from 'fastify';
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
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const app = {
      prisma: { encryptedObject: {
        findFirst: vi.fn(async () => duplicate ? { createdBy: 'foreign-account' } : null),
        create: vi.fn(async () => ({ id: 'own-object' })),
      } }, io: {}, authenticate: vi.fn(),
      get: vi.fn(),
      post: (path: string, _options: unknown, handler: (request: unknown) => Promise<unknown>) => handlers.set(path, handler),
    };
    await verificationRoutes(app as unknown as FastifyInstance);
    const request = { user: { userId: 'uploader' }, file: async () => ({
      filename: 'document.pdf', mimetype: 'application/pdf', toBuffer: async () => Buffer.from('%PDF-synthetic-document'),
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
  });
});
