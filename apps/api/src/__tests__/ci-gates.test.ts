import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'path';

/**
 * [CI-01] EVERY UNIT SUITE IN THE REPOSITORY RUNS IN CI.
 *
 * A red test only gates a merge if something runs it. The workflow ran the API
 * and mobile suites and nothing else, so every test in `apps/admin` and
 * `apps/web` — the admin console's session and dashboard-honesty tests, the
 * public site's route-authority, origin and legal-document tests — could fail
 * on a pull request and the pull request would still be green. Those suites
 * existed; they simply were not a gate.
 *
 * This test is the gate on the gate. It reads the real workflow and asserts
 * that every workspace package that declares a `test` script is actually
 * invoked by it, so a new app cannot be added with tests that never run, and
 * an existing invocation cannot be quietly deleted.
 */

const ROOT = resolve(process.cwd(), '../..');
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml');
const APPS = join(ROOT, 'apps');

function packagesWithTests(): { dir: string; name: string }[] {
  return readdirSync(APPS)
    .map((dir) => ({ dir, manifest: join(APPS, dir, 'package.json') }))
    .filter(({ manifest }) => existsSync(manifest))
    .map(({ dir, manifest }) => ({ dir, pkg: JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; scripts?: Record<string, string> } }))
    .filter(({ pkg }) => typeof pkg.scripts?.['test'] === 'string' && pkg.scripts['test'].trim() !== '')
    .map(({ dir, pkg }) => ({ dir, name: pkg.name ?? `@swift/${dir}` }));
}

describe('[CI-01] the workflow runs every unit suite that exists', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');

  it('finds the suites — this test is not vacuous', () => {
    const packages = packagesWithTests().map((p) => p.name);
    expect(packages).toEqual(expect.arrayContaining(['@swift/mobile', '@swift/admin', '@swift/web']));
    expect(packages.length).toBeGreaterThanOrEqual(3);
  });

  it.each(packagesWithTests())('runs $name', ({ name }) => {
    // the API suite is its own job (it needs Postgres and Redis services); the
    // rest are invoked by name from the lint/type-check job
    if (name === '@swift/api') {
      expect(workflow).toMatch(/name:\s*API Tests/);
      return;
    }
    expect(workflow).toContain(`pnpm --filter ${name} test`);
  });

  it('the API suite still has its own job with a database and a redis', () => {
    expect(workflow).toMatch(/name:\s*API Tests/);
    expect(workflow).toContain('postgres');
    expect(workflow).toContain('redis');
  });

  it('no suite is invoked with a flag that lets a failure pass', () => {
    for (const line of workflow.split('\n')) {
      if (!line.includes('pnpm --filter') || !line.includes(' test')) continue;
      expect(line, line.trim()).not.toMatch(/\|\|\s*true|--passWithNoTests|continue-on-error/);
    }
    // and no step anywhere is allowed to fail silently
    expect(workflow).not.toContain('continue-on-error: true');
  });
});


describe('migration-based development scripts', () => {
  it('applies checked-in migrations on every named setup path', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const api = JSON.parse(readFileSync(join(APPS, 'api/package.json'), 'utf8'));
    for (const command of [root.scripts['db:sync'], root.scripts['fix:env'], api.scripts.dev]) {
      expect(command).toContain('prisma migrate deploy');
      expect(command).not.toMatch(/prisma\s+db\s+push/);
    }
    expect(root.scripts['fix:env']).toMatch(/migrate deploy.*&&.*prisma db seed/);
    expect(api.scripts.dev).toMatch(/migrate deploy.*&&.*tsx watch/);
  });
  it('the text gate refuses unsafe package and shell setup paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swift-db-script-gate-'));
    const gate = join(ROOT, 'scripts/check-db-scripts.mjs');
    try {
      expect(spawnSync('git', ['init', '-q', dir]).status).toBe(0);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { setup: 'npx prisma db push' } }));
      expect(spawnSync('git', ['add', 'package.json'], { cwd: dir }).status).toBe(0);
      const unsafe = spawnSync(process.execPath, [gate], { cwd: dir, encoding: 'utf8' });
      expect(unsafe.status, unsafe.stderr).toBe(1);
      expect(unsafe.stderr).toContain('scripts.setup');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { setup: 'npx prisma migrate deploy' } }));
      const safe = spawnSync(process.execPath, [gate], { cwd: dir, encoding: 'utf8' });
      expect(safe.status, safe.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it.each([
    ['deploy/setup.sh', 'npx prisma db push'],
    ['infrastructure/setup.py', 'command = "npx prisma db push"'],
    ['.github/actions/setup/action.yml', 'run: npx prisma db push'],
    ['scripts/setup.cjs', 'execSync("npx prisma db push")'],
    ['Makefile', 'sync:\n\tnpx prisma db push'],
    ['apps/api/Makefile', 'sync:\n\tnpx prisma db push'],
    ['scripts/continued.sh', 'npx prisma db \\\n push'],
    ['scripts/concatenated.js', 'execSync("npx prisma db " + "push")'],
  ])('refuses raw schema reconciliation in %s', (file, command) => {
    const dir = mkdtempSync(join(tmpdir(), 'swift-db-script-gate-'));
    try {
      expect(spawnSync('git', ['init', '-q', dir]).status).toBe(0);
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), command);
      expect(spawnSync('git', ['add', file], { cwd: dir }).status).toBe(0);
      const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-db-scripts.mjs')], { cwd: dir, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(file);
    } finally { rmSync(dir, { recursive: true }); }
  });
  it('runs the raw db push text gate in CI', () => {
    expect(readFileSync(WORKFLOW, 'utf8')).toContain('node scripts/check-db-scripts.mjs');
  });
});
