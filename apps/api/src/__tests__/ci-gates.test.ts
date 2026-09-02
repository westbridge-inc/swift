import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
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
