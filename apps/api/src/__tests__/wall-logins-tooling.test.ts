import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('login provisioning contract', () => {
  it('passes the service-free operator-tool tests', () => {
    const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', 'deploy/tests', '-p', 'test_rls_logins.py', '-v'], {
      cwd: join(__dirname, '../../../..'),
      encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env['PATH'], PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9][0-9]* tests/);
  });
});
