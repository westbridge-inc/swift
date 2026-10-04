import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStorageProvider } from '../providers/storage/storage-provider';
import { assertSafeBootConfig } from '../utils/boot-config';

afterEach(() => vi.unstubAllEnvs());

describe('MASTER-074 storage durability boundary', () => {
  it.each([undefined, 'prod'])('refuses an invalid runtime mode (%s) at the direct adapter boundary', (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    expect(() => new LocalStorageProvider()).toThrow(/NODE_ENV/);
  });
  it('does not allow staging development mode to bypass storage posture', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', PILOT_ENV: 'staging', STORAGE_PROVIDER: 'local' })).toThrow(/storage|STORAGE/);
  });
  it('refuses a direct local adapter in a managed runtime without an explicit persistent root', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('STORAGE_DEPLOYMENT', 'managed');
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    vi.stubEnv('STORAGE_ALLOW_LOCAL', '1');
    vi.stubEnv('UPLOAD_DIR', '');
    expect(() => new LocalStorageProvider()).toThrow(/UPLOAD_DIR/);
  });
  it('requires a separate local-byte backup acknowledgement', () => {
    vi.stubEnv('STORAGE_DEPLOYMENT', 'managed');
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    vi.stubEnv('STORAGE_ALLOW_LOCAL', '1');
    vi.stubEnv('UPLOAD_DIR', '/synthetic/absolute/root');
    vi.stubEnv('STORAGE_LOCAL_BACKUP_ACK', '');
    expect(() => new LocalStorageProvider()).toThrow(/STORAGE_LOCAL_BACKUP_ACK/);
  });
  it('new API and worker adapters read the same synthetic bytes at an explicit root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'audit-pkg09-storage-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_DEPLOYMENT', 'managed');
    vi.stubEnv('STORAGE_PROVIDER', 'local');
    vi.stubEnv('STORAGE_ALLOW_LOCAL', '1');
    vi.stubEnv('UPLOAD_DIR', root);
    vi.stubEnv('STORAGE_LOCAL_BACKUP_ACK', '1');
    try {
      const bytes = Buffer.from('synthetic private document bytes');
      const { url } = await new LocalStorageProvider().upload({ buffer: bytes, filename: 'fixture.enc', mimeType: 'application/octet-stream', folder: 'verification/fixture' });
      expect(await new LocalStorageProvider().getObject(url)).toEqual(bytes);
      const worker = new LocalStorageProvider();
      expect(await worker.getObject(url)).toEqual(bytes);
      const another = { buffer: bytes, filename: 'another.enc', mimeType: 'application/octet-stream', folder: 'verification/fixture' };
      vi.stubEnv('STORAGE_LOCAL_BACKUP_ACK', '');
      await expect(worker.upload(another)).rejects.toThrow(/STORAGE_LOCAL_BACKUP_ACK/);
      vi.stubEnv('STORAGE_LOCAL_BACKUP_ACK', '1');
      vi.stubEnv('UPLOAD_DIR', join(root, 'changed'));
      await expect(worker.upload(another)).rejects.toThrow(/Storage root changed/);
      vi.stubEnv('UPLOAD_DIR', root);
      await worker.delete(url);
      await expect(new LocalStorageProvider().getObject(url)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
