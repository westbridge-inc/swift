import { vi } from 'vitest';
import type { StorageUploadInput } from '../../providers/storage/storage-provider';

/** In-memory provider: no filesystem or real provider object can be destroyed
 * by a document lifecycle test. It implements reservation and absence probes. */
const storageState = vi.hoisted(() => {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    purgeNamespace: async () => 'synthetic:document-lifecycle',
    upload: async (input: StorageUploadInput) => {
      const { randomUUID } = await import('node:crypto');
      const extension = input.filename.slice(input.filename.lastIndexOf('.')) || '.bin';
      const url = `${process.env['STORAGE_PROVIDER'] === 's3' || process.env['STORAGE_PROVIDER'] === 'r2' ? '' : '/uploads/'}${input.folder}/${randomUUID().replaceAll('-', '').slice(0, 16)}${extension}`;
      if (input.folder.startsWith('verification/')) {
        if (!input.reserve) throw new Error('Synthetic verification upload requires reservation');
        await input.reserve(url, 'synthetic:document-lifecycle');
      }
      if (objects.has(url)) throw new Error('Synthetic create-only conflict');
      objects.set(url, input.buffer);
      return { url };
    },
    getSignedUrl: async (key: string) => `synthetic:${key}`,
    delete: async (key: string) => { objects.delete(key); },
    getObject: async (key: string) => {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error('Synthetic object absent'), { code: 'ENOENT' });
      return bytes;
    },
  };
});
vi.mock('../../providers/storage/storage-provider', async (original) => ({
  ...await original<object>(), getStorageProvider: () => storageState,
}));

export const syntheticDocumentStorage = storageState;
