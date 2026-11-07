/**
 * The local file store checks every path it touches, in the method that touches it: an upload
 * folder, a delete and a read never reach a file outside the uploads folder (a climb with `..`,
 * an absolute path, a NUL byte). Valid keys behave exactly as before; delete stays best-effort
 * for a valid key (a missing file is a quiet no-op) and refuses an escaping key as it always did.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from '../providers/storage/storage-provider';

const ESCAPE = /escapes the uploads directory/;

// Every path the store hands to unlink, so a test can prove a refused path never reaches it
// (the real unlink still runs: behaviour is unchanged).
const unlinkCalls = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, unlink: (p: Parameters<typeof real.unlink>[0]) => { unlinkCalls.push(String(p)); return real.unlink(p); } };
});

describe('LocalStorageProvider checks every path inline', () => {
  const saved = process.env['UPLOAD_DIR'];
  let root = '';
  let uploads = '';
  let outside = '';
  let storage: LocalStorageProvider;
  // Not a photo, so the bytes are stored as they came (no image clean-up in the way).
  const file = (folder: string) => ({ buffer: Buffer.from('%PDF-1.4 test'), filename: 'doc.pdf', mimeType: 'application/pdf', folder });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'swift-local-paths-'));
    uploads = join(root, 'uploads');
    outside = join(root, 'outside');
    mkdirSync(join(uploads, 'verification', 'u1'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(uploads, 'verification', 'u1', 'aaaaaaaaaaaaaaaa.pdf'), Buffer.from('inside-bytes'));
    writeFileSync(join(outside, 'secret.txt'), Buffer.from('not-yours'));
    process.env['UPLOAD_DIR'] = uploads;
    storage = new LocalStorageProvider();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['UPLOAD_DIR']; else process.env['UPLOAD_DIR'] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('a valid folder still stores the file under the uploads folder and returns its key', async () => {
      const { url } = await storage.upload(file('verification/u2'));
      expect(url).toMatch(/^\/uploads\/verification\/u2\/[A-Za-z0-9_-]{16}\.pdf$/);
      expect(readFileSync(join(uploads, url.replace(/^\/uploads\//, '')))).toEqual(Buffer.from('%PDF-1.4 test'));
    });

    it('a folder that climbs out with .. is refused and nothing is written outside', async () => {
      await expect(storage.upload(file('../outside'))).rejects.toThrow(ESCAPE);
      await expect(storage.upload(file('verification/../../outside'))).rejects.toThrow(ESCAPE);
      expect(readdirSync(outside)).toEqual(['secret.txt']);
    });

    it('a folder that is the uploads folder itself is refused (a stored file always has its own folder)', async () => {
      await expect(storage.upload(file(''))).rejects.toThrow(ESCAPE);
      await expect(storage.upload(file('verification/..'))).rejects.toThrow(ESCAPE);
    });

    it('a folder with a NUL byte is refused', async () => {
      await expect(storage.upload(file('verification/u1\0/x'))).rejects.toThrow(ESCAPE);
    });

    it('an absolute folder never lands outside the uploads folder', async () => {
      const result = await storage.upload(file(outside)).then((r) => r, (e: Error) => e);
      // Joined under the uploads folder (as before) or refused: either way, never the outside folder.
      if (result instanceof Error) expect(result.message).toMatch(ESCAPE);
      else expect(existsSync(join(uploads, result.url.replace(/^\/uploads\//, '')))).toBe(true);
      expect(readdirSync(outside)).toEqual(['secret.txt']);
    });
  });

  describe('getObject', () => {
    it('a valid key still reads the file (with or without the /uploads/ prefix)', async () => {
      await expect(storage.getObject('/uploads/verification/u1/aaaaaaaaaaaaaaaa.pdf')).resolves.toEqual(Buffer.from('inside-bytes'));
      await expect(storage.getObject('verification/u1/aaaaaaaaaaaaaaaa.pdf')).resolves.toEqual(Buffer.from('inside-bytes'));
    });

    it('a key that climbs out, an absolute path and a NUL byte are refused, never read', async () => {
      await expect(storage.getObject('../outside/secret.txt')).rejects.toThrow(ESCAPE);
      await expect(storage.getObject('/uploads/../outside/secret.txt')).rejects.toThrow(ESCAPE);
      await expect(storage.getObject(join(outside, 'secret.txt'))).rejects.toThrow(ESCAPE);
      await expect(storage.getObject('verification/u1/aaaaaaaaaaaaaaaa.pdf\0')).rejects.toThrow(ESCAPE);
    });

    it('the uploads folder itself is refused, not read', async () => {
      await expect(storage.getObject('/uploads/')).rejects.toThrow(ESCAPE);
      await expect(storage.getObject('')).rejects.toThrow(ESCAPE);
    });
  });

  describe('delete', () => {
    it('a valid key still deletes the file', async () => {
      const target = join(uploads, 'verification', 'u1', 'bbbbbbbbbbbbbbbb.pdf');
      writeFileSync(target, Buffer.from('to-delete'));
      await expect(storage.delete('/uploads/verification/u1/bbbbbbbbbbbbbbbb.pdf')).resolves.toBeUndefined();
      expect(existsSync(target)).toBe(false);
    });

    it('a missing file is still a quiet no-op (best-effort)', async () => {
      await expect(storage.delete('/uploads/verification/u1/cccccccccccccccc.pdf')).resolves.toBeUndefined();
    });

    it('a key that climbs out, an absolute path or a NUL byte is refused (as before) and deletes nothing', async () => {
      await expect(storage.delete('../outside/secret.txt')).rejects.toThrow(ESCAPE);
      await expect(storage.delete('/uploads/../outside/secret.txt')).rejects.toThrow(ESCAPE);
      await expect(storage.delete(join(outside, 'secret.txt'))).rejects.toThrow(ESCAPE);
      await expect(storage.delete('verification/u1/aaaaaaaaaaaaaaaa.pdf\0')).rejects.toThrow(ESCAPE);
      expect(unlinkCalls.filter((p) => !p.startsWith(uploads + '/'))).toEqual([]);
      expect(readFileSync(join(outside, 'secret.txt'))).toEqual(Buffer.from('not-yours'));
      expect(readFileSync(join(uploads, 'verification', 'u1', 'aaaaaaaaaaaaaaaa.pdf'))).toEqual(Buffer.from('inside-bytes'));
    });

    it('the uploads folder itself is never deleted: a quiet no-op, as before, never handed to unlink', async () => {
      unlinkCalls.length = 0;
      await expect(storage.delete('/uploads/')).resolves.toBeUndefined();
      await expect(storage.delete('')).resolves.toBeUndefined();
      expect(unlinkCalls).toEqual([]);
      expect(existsSync(join(uploads, 'verification', 'u1', 'aaaaaaaaaaaaaaaa.pdf'))).toBe(true);
    });
  });
});
