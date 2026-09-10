import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LocalStorageProvider,
  StorageObjectTooLargeError,
} from '../providers/storage/storage-provider';

describe('verification object generation authority', () => {
  let baseDir: string;
  let storage: LocalStorageProvider;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'swift-object-generation-'));
    storage = new LocalStorageProvider({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('refuses to read or delete a key when the claimed generation differs', async () => {
    const bytes = Buffer.from('first immutable generation');
    const stored = await storage.upload({
      buffer: bytes,
      filename: 'evidence.bin',
      mimeType: 'application/octet-stream',
      folder: 'verification/test-account',
      fileKey: '/uploads/verification/test-account/evidence.bin',
    });
    const wrongVersion = `sha256:${'0'.repeat(64)}`;

    expect(stored.objectVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await storage.probe(stored.url, stored.objectVersion)).toBe('PRESENT');
    expect(await storage.probe(stored.url, wrongVersion)).toBe('MISMATCH');
    await expect(storage.getObject(stored.url, wrongVersion)).rejects.toThrow(/generation/);
    await expect(storage.deleteExact(stored.url, wrongVersion)).rejects.toThrow(/generation/);
    await expect(storage.getObject(stored.url, stored.objectVersion)).resolves.toEqual(bytes);
  });

  it('deletes only the exact acknowledged generation and confirms its absence', async () => {
    const stored = await storage.upload({
      buffer: Buffer.from('purge this exact generation'),
      filename: 'purge.bin',
      mimeType: 'application/octet-stream',
      folder: 'verification/test-account',
      fileKey: '/uploads/verification/test-account/purge.bin',
    });

    await storage.deleteExact(stored.url, stored.objectVersion);
    expect(await storage.probe(stored.url, stored.objectVersion)).toBe('ABSENT');
  });

  it('never overwrites an existing generation at a reserved key', async () => {
    const fileKey = '/uploads/verification/test-account/collision.bin';
    const first = await storage.upload({
      buffer: Buffer.from('original'),
      filename: 'collision.bin',
      mimeType: 'application/octet-stream',
      folder: 'verification/test-account',
      fileKey,
    });

    await expect(storage.upload({
      buffer: Buffer.from('replacement'),
      filename: 'collision.bin',
      mimeType: 'application/octet-stream',
      folder: 'verification/test-account',
      fileKey,
    })).rejects.toThrow();
    await expect(storage.getObject(first.url, first.objectVersion)).resolves.toEqual(Buffer.from('original'));
  });

  it('stops a secure read while streaming before an oversized object is fully buffered', async () => {
    const bytes = Buffer.alloc(256 * 1024, 0x41);
    const stored = await storage.upload({
      buffer: bytes,
      filename: 'oversized.bin',
      mimeType: 'application/octet-stream',
      folder: 'verification/test-account',
      fileKey: '/uploads/verification/test-account/oversized.bin',
    });

    await expect(storage.getObject(stored.url, stored.objectVersion, { maxBytes: 64 * 1024 }))
      .rejects.toBeInstanceOf(StorageObjectTooLargeError);
    await expect(storage.getObject(stored.url, stored.objectVersion, { maxBytes: bytes.length }))
      .resolves.toEqual(bytes);
  });

  it('honours an already-revoked read signal before returning any bytes', async () => {
    const stored = await storage.upload({
      buffer: Buffer.from('sensitive bytes'),
      filename: 'abort.bin',
      mimeType: 'application/octet-stream',
      folder: 'verification/test-account',
      fileKey: '/uploads/verification/test-account/abort.bin',
    });
    const controller = new AbortController();
    controller.abort(new Error('review deadline elapsed'));

    await expect(storage.getObject(stored.url, stored.objectVersion, { maxBytes: 1024, signal: controller.signal }))
      .rejects.toThrow('review deadline elapsed');
  });
});
