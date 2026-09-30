import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ mkdir: vi.fn(), writeFile: vi.fn(), send: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<object>(), mkdir: calls.mkdir, writeFile: calls.writeFile }));
vi.mock('@aws-sdk/client-s3', async (original) => ({ ...await original<object>(), S3Client: class { send = calls.send; } }));
import { LocalStorageProvider, S3StorageProvider } from '../providers/storage/storage-provider';
import { GetBucketVersioningCommand, PutObjectCommand } from '@aws-sdk/client-s3';
const upload = { folder: 'verification/synthetic-owner', filename: 'source.enc', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic ciphertext') };
beforeEach(() => {
  vi.stubEnv('UPLOAD_DIR', '/synthetic/document-store');
  vi.stubEnv('AWS_S3_BUCKET', 'synthetic-bucket');
  vi.stubEnv('AWS_S3_ENDPOINT', 'https://objects.example.invalid/namespace');
  calls.send.mockResolvedValue({});
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
describe('verification source reservations at synthetic adapter boundaries', () => {
  it.each(['local', 'object'] as const)('%s refuses verification upload without a committed reservation', async (kind) => {
    const store = kind === 'local' ? new LocalStorageProvider() : new S3StorageProvider();
    await expect(store.upload(upload)).rejects.toThrow('committed source reservation');
    expect(calls.writeFile).not.toHaveBeenCalled(); expect(calls.send).not.toHaveBeenCalled();
  });
  it.each(['local', 'object'] as const)('%s cannot write bytes when source reservation rolls back', async (kind) => {
    const store = kind === 'local' ? new LocalStorageProvider() : new S3StorageProvider();
    await expect(store.upload({ ...upload, reserve: async () => { throw new Error('synthetic reservation rollback'); } })).rejects.toThrow('synthetic reservation rollback');
    expect(calls.writeFile).not.toHaveBeenCalled();
    expect(calls.send.mock.calls.every(([c]) => c instanceof GetBucketVersioningCommand)).toBe(true);
  });
  it.each(['local', 'object'] as const)('%s reserves the exact name before a create-only write', async (kind) => {
    const store = kind === 'local' ? new LocalStorageProvider() : new S3StorageProvider();
    let reserved = '';
    const result = await store.upload({ ...upload, reserve: async (key, namespace) => {
      expect(calls.writeFile).not.toHaveBeenCalled();
      expect(calls.send.mock.calls.some(([c]) => c instanceof PutObjectCommand)).toBe(false);
      expect(namespace).toBe(await store.purgeNamespace()); reserved = key;
    } });
    expect(result.url).toBe(reserved);
    if (kind === 'local') expect(calls.writeFile).toHaveBeenCalledWith(expect.stringContaining(reserved.replace('/uploads/', '')), upload.buffer, { flag: 'wx' });
    else expect(calls.send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Key: reserved, IfNoneMatch: '*' }) }));
  });
  it.each(['Enabled', 'Suspended'])('refuses %s versioning before source reservation or upload', async (Status) => {
    calls.send.mockResolvedValue({ Status }); const reserve = vi.fn();
    await expect(new S3StorageProvider().upload({ ...upload, reserve })).rejects.toThrow('exact-version authority');
    expect(reserve).not.toHaveBeenCalled();
    expect(calls.send.mock.calls.every(([c]) => c instanceof GetBucketVersioningCommand)).toBe(true);
  });
  it('namespace binds endpoint path and bucket without including credentials or object bytes', async () => {
    const first = await new S3StorageProvider().purgeNamespace();
    vi.stubEnv('AWS_S3_ENDPOINT', 'https://objects.example.invalid/another-namespace');
    expect(await new S3StorageProvider().purgeNamespace()).not.toBe(first);
    vi.stubEnv('AWS_S3_BUCKET', 'synthetic-other-bucket');
    expect(await new S3StorageProvider().purgeNamespace()).toMatch(/^object:[a-f0-9]{64}$/);
  });
});

it.each(['local', 'object'] as const)('%s waits for reservation commit before any byte write', async (kind) => {
  let release!: () => void; let reached!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  const store = kind === 'local' ? new LocalStorageProvider() : new S3StorageProvider();
  const writing = store.upload({ ...upload, reserve: async () => { reached(); await pending; } });
  await entered;
  try {
    expect(calls.writeFile).not.toHaveBeenCalled();
    expect(calls.send.mock.calls.some(([c]) => c instanceof PutObjectCommand)).toBe(false);
  } finally { release(); await writing; }
});
