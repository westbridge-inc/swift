import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('upload lifetime outside the application process', () => {
  it('offline deployment checker accepts durable configurations and refuses split or ephemeral storage', () => {
    const result = spawnSync('python3', ['-m', 'unittest', 'deploy/test_upload_storage_check.py'], {
      cwd: resolve(__dirname, '../../../..'), encoding: 'utf8', timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Ran 7 tests');
  });

  it('new API and worker processes read the same bytes; isolated backup restores them and worker deletion persists', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'upload-lifetime-'));
    const root = join(scratch, 'external-volume');
    const backup = join(scratch, 'backup');
    const restored = join(scratch, 'restored-volume');
    const processAt = (directory: string, operation: string, key?: string) => spawnSync(process.execPath,
      ['--import', 'tsx', resolve(__dirname, 'fixtures/storage-process.ts'), operation, ...(key ? [key] : [])], {
        encoding: 'utf8', timeout: 10000,
        env: { PATH: process.env['PATH'], NODE_ENV: 'test', STORAGE_PROVIDER: 'local', STORAGE_DEPLOYMENT: 'managed',
          STORAGE_ALLOW_LOCAL: '1', STORAGE_LOCAL_BACKUP_ACK: '1', UPLOAD_DIR: directory },
      });
    try {
      const upload = processAt(root, 'upload');
      expect(upload.status, upload.stderr).toBe(0);
      const key = upload.stdout;
      expect(key).toMatch(/^\/uploads\/verification\/synthetic-subject\/.+\.enc$/);
      const expected = createHash('sha256').update('synthetic private envelope bytes').digest('hex');
      for (const actor of ['replacement-api', 'replacement-worker']) {
        const read = processAt(root, 'read', key);
        expect(read.status, actor).toBe(0);
        expect(read.stdout, actor).toBe(expected);
      }
      await cp(root, backup, { recursive: true });
      await cp(backup, restored, { recursive: true });
      expect(processAt(restored, 'read', key).stdout).toBe(expected);
      // A different empty container directory cannot accidentally pass.
      expect(processAt(join(scratch, 'ephemeral-root'), 'read', key).status).toBe(1);
      expect(processAt(root, 'delete', key).status).toBe(0);
      expect(processAt(root, 'read', key).status).toBe(1);
      // Restored copies need the separately documented hold/erasure replay.
      expect(processAt(restored, 'read', key).stdout).toBe(expected);
      expect(processAt(restored, 'delete', key).status).toBe(0);
      expect(processAt(restored, 'read', key).status).toBe(1);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
