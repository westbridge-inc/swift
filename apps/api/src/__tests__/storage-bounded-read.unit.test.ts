/**
 * [IMAGES-E2E] The local adapter's bounded read (the public photo door's only read): it reads a
 * file INSIDE the uploads folder, at most `maxBytes`, and nothing else: not the folder itself,
 * not a missing file, never a path that climbs out.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorageProvider } from '../providers/storage/storage-provider';

describe('[IMAGES-E2E] LocalStorageProvider.getObjectWithin', () => {
  const saved = process.env['UPLOAD_DIR'];
  let root = '';
  let storage: LocalStorageProvider;
  const signal = () => new AbortController().signal;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'swift-bounded-read-'));
    mkdirSync(join(root, 'uploads', 'portfolio', 'p1'), { recursive: true });
    writeFileSync(join(root, 'uploads', 'portfolio', 'p1', 'aaaaaaaaaaaaaaaa.jpg'), Buffer.from('photo-bytes'));
    writeFileSync(join(root, 'outside.jpg'), Buffer.from('not-yours'));
    process.env['UPLOAD_DIR'] = join(root, 'uploads');
    storage = new LocalStorageProvider();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['UPLOAD_DIR']; else process.env['UPLOAD_DIR'] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('reads a file inside the uploads folder, within the limit', async () => {
    await expect(storage.getObjectWithin('portfolio/p1/aaaaaaaaaaaaaaaa.jpg', 1024, signal())).resolves.toEqual(Buffer.from('photo-bytes'));
    await expect(storage.getObjectWithin('/uploads/portfolio/p1/aaaaaaaaaaaaaaaa.jpg', 1024, signal())).resolves.toEqual(Buffer.from('photo-bytes'));
  });

  it('a file larger than the limit, a missing file and the uploads folder itself read as nothing', async () => {
    await expect(storage.getObjectWithin('portfolio/p1/aaaaaaaaaaaaaaaa.jpg', 4, signal())).resolves.toBeNull();
    await expect(storage.getObjectWithin('portfolio/p1/bbbbbbbbbbbbbbbb.jpg', 1024, signal())).resolves.toBeNull();
    await expect(storage.getObjectWithin('', 1024, signal())).resolves.toBeNull();
    await expect(storage.getObjectWithin('/uploads/', 1024, signal())).resolves.toBeNull();
  });

  it('a path that climbs out of the uploads folder is refused, never read', async () => {
    await expect(storage.getObjectWithin('../outside.jpg', 1024, signal())).rejects.toThrow(/escapes the uploads directory/);
    await expect(storage.getObjectWithin('/uploads/../outside.jpg', 1024, signal())).rejects.toThrow(/escapes the uploads directory/);
  });
});
