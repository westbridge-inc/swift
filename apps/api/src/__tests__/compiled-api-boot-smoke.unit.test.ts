import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// [HARDEN item 0] 15 Oct 2026: main was green while the compiled API could not
// start (#1712 required a value from the source-only @swift/types: "SyntaxError:
// Unexpected token 'export'"; production crash-looped; hotfix #1773). The suite
// runs the TypeScript source, so nothing ran apps/api/dist. CI now starts API
// Build's own output (job "API Boot Smoke", scripts/compiled-api-boot-smoke.mjs).
// These tests drive the script's module phase on small compiled trees, and read
// the real workflow so the job cannot quietly stop running the real build.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'compiled-api-boot-smoke.mjs');
const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A compiled API tree: apps/api/dist + node_modules. Entrypoints run if loaded, which must never happen. */
function compiledTree(files: Record<string, string>, omit: string[] = []): string {
  const api = join(mkdtempSync(join(tmpdir(), 'boot-smoke-')), 'apps', 'api');
  roots.push(dirname(dirname(api)));
  const tree: Record<string, string> = {
    'dist/server.js': 'process.exit(7);\n',
    'dist/worker.js': "throw new Error('the worker entrypoint ran while loading modules');\n",
    'dist/boot/migrate-deploy.js': 'process.exit(9);\n',
    'dist/boot/secret-files.js': "process.env.BOOT_SMOKE_FIXTURE_SECRET = 'from-file';\n",
    'dist/scripts/backfill.js': "throw new Error('an operator program ran while loading modules');\n",
    // Sorts before boot/: it loads cleanly only when the secret loader ran first, as in every entrypoint.
    'dist/a-reads-secret.js': "if (process.env.BOOT_SMOKE_FIXTURE_SECRET !== 'from-file') throw new Error('secret loader did not run first');\n",
    'dist/modules/ok.js': "'use strict';\nconst path = require(\"path\");\nconst ok = require(\"fixture-cjs\");\nexports.v = ok.v + path.sep.length;\n",
    'node_modules/fixture-cjs/package.json': '{"name":"fixture-cjs","main":"./index.js"}\n',
    'node_modules/fixture-cjs/index.js': 'exports.v = 1;\n',
    // Like @swift/types: TypeScript source (a type in it, so it is neither CommonJS nor plain ESM), no "require" build.
    'node_modules/@swift/source-only/package.json': '{"name":"@swift/source-only","main":"./src/index.ts","types":"./src/index.ts"}\n',
    'node_modules/@swift/source-only/src/index.ts': "export interface ServiceJobContract { version: string }\nexport const SERVICE_JOB_CONTRACT_VERSION = '1';\n",
    ...files,
  };
  for (const [rel, body] of Object.entries(tree)) {
    if (omit.includes(rel)) continue;
    mkdirSync(dirname(join(api, rel)), { recursive: true });
    writeFileSync(join(api, rel), body);
  }
  return api;
}

function loadModules(api: string): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--phase', 'modules', '--api-dir', api], {
    cwd: api,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, BOOT_SMOKE_FIXTURE_SECRET: '' },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('the boot smoke loads every compiled module and every package they name', () => {
  it('passes a compiled tree that loads, without running an entrypoint or an operator program', () => {
    const { code, output } = loadModules(compiledTree({}));
    expect(output).toContain('modules: 3/3 compiled modules loaded; 1/1 named packages loaded');
    expect(output).not.toContain('FAIL');
    expect(code).toBe(0);
  });

  it("fails on the 15 Oct crash: a value required from a source-only workspace package", () => {
    const { code, output } = loadModules(compiledTree({
      'dist/modules/services/service-job-client-contract.js':
        "'use strict';\nconst types_1 = require(\"@swift/source-only\");\nexports.VERSION = types_1.SERVICE_JOB_CONTRACT_VERSION;\n",
    }));
    expect(output).toContain("FAIL modules/services/service-job-client-contract.js: SyntaxError: Unexpected token 'export'");
    expect(output).toContain('FAIL package "@swift/source-only"');
    expect(code).toBe(1);
  });

  it('fails on a package named only inside a lazy import(), which no boot path would load', () => {
    const { code, output } = loadModules(compiledTree({
      'dist/modules/later.js': "'use strict';\nexports.later = () => Promise.resolve().then(() => require('package-that-is-not-installed'));\n",
    }));
    expect(output).toContain('FAIL package "package-that-is-not-installed" (named in modules/later.js)');
    expect(code).toBe(1);
  });

  it('fails on a library module that ends the process while loading, instead of letting it decide the verdict', () => {
    const { code, output } = loadModules(compiledTree({ 'dist/modules/exits.js': 'process.exit(0);\n' }));
    expect(output).toContain('FAIL modules/exits.js: Error: called process.exit(0) while loading');
    expect(code).toBe(1);
  });

  it('fails when an entrypoint it runs as a process is missing, so the list cannot go stale quietly', () => {
    const { code, output } = loadModules(compiledTree({}, ['dist/worker.js']));
    expect(output).toContain('FAIL worker.js: missing from dist/');
    expect(code).toBe(1);
  });
});

/** The text of one job: from `  <id>:` to the next two-space-indented key. */
function jobBlock(id: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line === `  ${id}:`);
  expect(start, `job ${id} exists in ci.yml`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[a-z][\w-]*:\s*$/.test(lines[end] ?? '')) end += 1;
  return lines.slice(start, end).join('\n');
}

describe('CI boots API Build\'s own compiled output', () => {
  const build = jobBlock('api-build');
  const smoke = jobBlock('api-boot-smoke');

  it('API Build builds like apps/api/Dockerfile (@swift/ui, then the API) and keeps both dist trees', () => {
    const ui = build.indexOf('run: pnpm --filter @swift/ui build');
    const api = build.indexOf('run: pnpm --filter @swift/api build');
    expect(ui).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(ui);
    const keep = build.slice(build.indexOf('uses: actions/upload-artifact@'));
    expect(keep).toContain('name: api-dist');
    expect(keep).toContain('apps/api/dist/');
    expect(keep).toContain('packages/ui/dist/');
    expect(keep).toContain('if-no-files-found: error');
  });

  it('the smoke job takes that output, migrates like production, then runs the smoke', () => {
    expect(smoke).toContain('name: API Boot Smoke');
    expect(smoke).toMatch(/^ {4}needs: api-build\s*$/m);
    expect(smoke).toMatch(/uses: actions\/download-artifact@\S+\n\s+with:\n\s+name: api-dist/);
    const migrate = smoke.indexOf('run: node dist/boot/migrate-deploy.js');
    const run = smoke.indexOf('run: node scripts/compiled-api-boot-smoke.mjs');
    expect(migrate).toBeGreaterThan(smoke.indexOf('name: api-dist'));
    expect(run).toBeGreaterThan(migrate);
    expect(smoke).toContain('postgres:');
    expect(smoke).toContain('redis:');
  });

  it('runs a non-production posture with file-delivered stand-ins, and nothing lets a failure pass', () => {
    expect(smoke).toMatch(/^ {6}NODE_ENV: loadtest\s*$/m);
    expect(smoke).not.toMatch(/NODE_ENV: production/);
    expect(smoke).toContain('bash deploy/wall/stand-in.sh "$name"');
    expect(smoke).toContain('echo "${name}_FILE=$dir/$name" >> "$GITHUB_ENV"');
    expect(smoke).not.toMatch(/continue-on-error|\|\|\s*true|DEV_OTP_BYPASS|CONSENT_REQUIRED|PREVIEW_MODE/);
  });
});
