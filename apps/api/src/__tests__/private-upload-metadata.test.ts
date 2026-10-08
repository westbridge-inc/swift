import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { decryptBuffer, getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { LocalStorageProvider, S3StorageProvider } from '../providers/storage/storage-provider';
import { PROGRESSIVE_JPEG, PROGRESSIVE_SCAN_OFFSETS, progressiveWithMetadata } from './fixtures/progressive-jpeg';

vi.mock('../modules/verification/verification.service', () => ({ VerificationService: class {} }));
vi.mock('../modules/notification/notification.service', () => ({ NotificationService: class {}, notifyAdmins: vi.fn(), tenantOfUser: vi.fn() }));
vi.mock('../providers/kyc/kyc-provider', () => ({ getKycProvider: () => ({}) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetKeyProviderForTests(); });

describe('private photo metadata at persistence boundaries', () => {
  const folders = ['avatars/subject', 'vehicles/rider', 'vehicles/driver', 'courier-proof/parcel/pickup', 'courier-proof/parcel/return', 'handover-proof/order', 'chat/room', 'liveness/subject'];
  it.each(['local', 's3'])('%s strips every scan before storing each private photo family', async (provider) => {
    const root = await mkdtemp(join(tmpdir(), 'private-photo-'));
    vi.stubEnv('UPLOAD_DIR', root);
    vi.stubEnv('AWS_S3_BUCKET', 'synthetic-private-photos');
    const stored = new Map<string, Buffer>();
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      if (!(command instanceof PutObjectCommand)) throw new Error('Unexpected provider operation');
      stored.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
      return {};
    }) as typeof S3Client.prototype.send);
    try {
      const storage = provider === 'local' ? new LocalStorageProvider() : new S3StorageProvider();
      for (const folder of folders) {
        for (const offset of PROGRESSIVE_SCAN_OFFSETS) {
          const { url } = await storage.upload({ buffer: progressiveWithMetadata(offset), filename: 'camera.jpg', mimeType: 'image/jpeg', folder });
          const actual = provider === 'local' ? await storage.getObject(url) : stored.get(url);
          expect(actual, `${folder} scan ${offset}`).toEqual(PROGRESSIVE_JPEG);
        }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['image/jpeg', 'image/png', 'application/pdf'])('verification multipart %s persists only sanitized plaintext inside the envelope', async (mimeType) => {
    const root = await mkdtemp(join(tmpdir(), 'private-document-'));
    vi.stubEnv('UPLOAD_DIR', root);
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 19).toString('base64'));
    resetKeyProviderForTests();
    const input = mimeType === 'application/pdf' ? Buffer.from('%PDF-1.4\nsynthetic document\n%%EOF') : progressiveWithMetadata(PROGRESSIVE_SCAN_OFFSETS[4]);
    const expected = mimeType === 'application/pdf' ? input : PROGRESSIVE_JPEG;
    const records: Record<string, unknown>[] = [];
    const app = Fastify();
    app.decorate('prisma', { encryptedObject: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { records.push(data); return data; }),
    } } as unknown as FastifyInstance['prisma']);
    app.decorate('io', {} as FastifyInstance['io']);
    app.decorate('authenticate', async (request: { user: unknown }) => { request.user = { userId: 'synthetic-subject' }; });
    await app.register(multipart);
    await app.register(verificationRoutes, { prefix: '/verification' });
    try {
      const boundary = 'synthetic-boundary';
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="camera.jpg"\r\nContent-Type: ${mimeType}\r\n\r\n`), input, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const response = await app.inject({ method: 'POST', url: '/verification/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, data: { url: expect.any(String) } });
      expect(records).toHaveLength(1);
      const record = records[0]!;
      const ciphertext = await new LocalStorageProvider().getObject(record['fileKey'] as string);
      const dek = await getKeyProvider()!.unwrapDek(Buffer.from(record['wrappedDek'] as Uint8Array));
      const plaintext = decryptBuffer(ciphertext, dek, Buffer.from(record['iv'] as Uint8Array), Buffer.from(record['authTag'] as Uint8Array));
      expect(plaintext).toEqual(expected);
      expect(record['sizeBytes']).toBe(expected.length);
      // Preserve the existing duplicate-document identity contract.
      expect(record['sha256']).toBe(createHash('sha256').update(input).digest('hex'));
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
