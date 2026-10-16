#!/usr/bin/env node
/**
 * [HARDEN · item 0] The COMPILED API must start, the way production starts it.
 *
 * 15 Oct 2026: main's CI was green while `node dist/server.js` could not start
 * at all. #1712 imported a value from @swift/types, a package that ships
 * TypeScript source only, so the compiled CommonJS API died on its first
 * require ("SyntaxError: Unexpected token 'export'") and production Phase F
 * crash-looped (hotfix #1773). Every test runs the TypeScript source through
 * vitest, so no check ever ran apps/api/dist. #1773's unit gate refuses that
 * one import shape; this smoke catches the whole class, whatever the cause:
 * an ESM-only dependency, a missing runtime dependency, a subpath a package
 * does not export, a module that throws while loading, an entrypoint that
 * exits on boot.
 *
 * Run from the repository root AFTER building like apps/api/Dockerfile
 * (packages/ui `pnpm run build`, apps/api `prisma generate` + `pnpm run build`)
 * and applying the migrations (`node dist/boot/migrate-deploy.js`):
 *
 *   node scripts/compiled-api-boot-smoke.mjs [--api-dir apps/api] [--port 3000]
 *
 * The caller's environment is the posture: a non-production NODE_ENV (CI uses
 * loadtest, the staging posture), the database and Redis, and the secrets as
 * NAME_FILE stand-ins. Nothing here sets or relaxes a boot guard: the API and
 * the worker run their own guards exactly as in a container.
 *
 *   1. modules  - every compiled module under dist/ loads (the entrypoints
 *                 below run as programs instead), and every package the
 *                 compiled code names, including inside a lazy import(),
 *                 resolves and loads from where it is named.
 *   2. api      - `node dist/server.js` (RUN_WORKERS=0, as in
 *                 deploy/docker-compose.yml) answers GET /health with 200.
 *   3. worker   - `node dist/worker.js` (RUN_WORKERS=1) writes its scheduler
 *                 heartbeat: the container's own probe
 *                 (dist/boot/worker-probe.js) exits 0.
 *   4. ready    - GET /ready answers 200 (the image HEALTHCHECK): the boot
 *                 contracts completed, so the boot path's lazy imports ran.
 *   5. stop     - SIGTERM: both processes exit 0 within the bound.
 * Each step is bounded; a process that exits early, or a bound that runs
 * out, fails the run with that process's last output lines.
 */
import { spawn } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Programs, not libraries: each runs on import, so it runs here as a process. */
const ENTRYPOINTS = ['server.js', 'worker.js', 'boot/migrate-deploy.js'];
/** One-shot operator programs (dist/scripts/*), run by hand: never loaded here. */
const OPERATOR_PROGRAMS_DIR = 'scripts/';
/** Loaded FIRST, as every entrypoint does: NAME_FILE secrets become NAME. */
const SECRET_LOADER = 'boot/secret-files.js';

const BOUND_MS = {
  modules: 120_000,
  health: 120_000,
  worker: 150_000,
  ready: 120_000,
  stop: 30_000,
};
const TAIL_LINES = 80;

function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function compiledFiles(distDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(distDir);
  return out.sort();
}

/** Bare package specifiers in compiled CommonJS: static require("x") and lazy import('x'). */
function packageSpecifiers(source) {
  const found = new Set();
  for (const match of source.matchAll(/\brequire\((["'])([^"'\s]+)\1\)/g)) {
    const spec = match[2];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    if (builtinModules.includes(spec.split('/')[0]) || builtinModules.includes(spec)) continue;
    found.add(spec);
  }
  return found;
}

function firstLine(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.split('\n')[0].slice(0, 300);
}

// ---------------------------------------------------------------------------
// Phase 1 runs in a child of its own (`--phase modules`), so a module that
// starts a timer or a connection while loading cannot keep this runner alive.
// ---------------------------------------------------------------------------
function loadEveryModule(apiDir) {
  const distDir = resolve(apiDir, 'dist');
  const realExit = process.exit;
  const failures = [];
  for (const entry of [...ENTRYPOINTS, SECRET_LOADER]) {
    if (!existsSync(join(distDir, entry))) failures.push(`${entry}: missing from dist/ (the entrypoint list is stale or the build is incomplete)`);
  }
  const files = compiledFiles(distDir).filter((file) => {
    const rel = relative(distDir, file).split('\\').join('/');
    return !ENTRYPOINTS.includes(rel) && !rel.startsWith(OPERATOR_PROGRAMS_DIR);
  });
  const ordered = [join(distDir, SECRET_LOADER), ...files.filter((f) => f !== join(distDir, SECRET_LOADER))];
  const specifiers = new Map();
  let loaded = 0;
  for (const file of ordered) {
    const rel = relative(distDir, file);
    const load = createRequire(file);
    // A library module that ends the process while loading is a failure, not a verdict.
    process.exit = (code) => { throw new Error(`called process.exit(${code}) while loading`); };
    try {
      load(file);
      loaded += 1;
    } catch (error) {
      failures.push(`${rel}: ${firstLine(error)}`);
    } finally {
      process.exit = realExit;
    }
    for (const spec of packageSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifiers.has(spec)) specifiers.set(spec, file);
    }
  }
  let packages = 0;
  for (const [spec, file] of specifiers) {
    process.exit = (code) => { throw new Error(`called process.exit(${code}) while loading`); };
    try {
      createRequire(file)(spec);
      packages += 1;
    } catch (error) {
      failures.push(`package "${spec}" (named in ${relative(distDir, file)}): ${firstLine(error)}`);
    } finally {
      process.exit = realExit;
    }
  }
  console.log(`modules: ${loaded}/${ordered.length} compiled modules loaded; ${packages}/${specifiers.size} named packages loaded`);
  for (const failure of failures.slice(0, 60)) console.log(`  FAIL ${failure}`);
  if (failures.length > 60) console.log(`  ... and ${failures.length - 60} more`);
  realExit.call(process, failures.length === 0 && loaded > 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------
class Proc {
  constructor(name, command, args, options) {
    this.name = name;
    this.lines = [];
    this.exited = null;
    this.child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() === '') continue;
        this.lines.push(line.slice(0, 2000));
        if (this.lines.length > TAIL_LINES) this.lines.shift();
      }
    };
    this.child.stdout.on('data', take);
    this.child.stderr.on('data', take);
    this.done = new Promise((resolveDone) => {
      this.child.on('exit', (code, signal) => {
        this.exited = { code, signal };
        resolveDone(this.exited);
      });
      this.child.on('error', (error) => {
        this.lines.push(`spawn error: ${firstLine(error)}`);
        this.exited = { code: null, signal: null, error };
        resolveDone(this.exited);
      });
    });
  }

  tail() {
    return [`----- last ${this.lines.length} output lines of ${this.name} -----`, ...this.lines, `----- end of ${this.name} -----`].join('\n');
  }

  describeExit() {
    const { code, signal } = this.exited ?? {};
    return signal ? `killed by ${signal}` : `exit code ${code}`;
  }
}

class SmokeFailure extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  } catch {
    return null;
  }
}

/** Polls `check` until it is true; fails if a watched process exits or the bound runs out. */
async function until(step, boundMs, watched, check) {
  const started = Date.now();
  let last = 'not reached';
  while (Date.now() - started < boundMs) {
    for (const proc of watched) {
      if (proc.exited) throw new SmokeFailure(`${step}: ${proc.name} exited (${proc.describeExit()}) before the step passed`);
    }
    const verdict = await check();
    if (verdict === true) {
      console.log(`${step}: ok after ${((Date.now() - started) / 1000).toFixed(1)} s`);
      return;
    }
    last = verdict;
    await sleep(1000);
  }
  throw new SmokeFailure(`${step}: not reached within ${boundMs / 1000} s (last: ${last})`);
}

async function main() {
  const apiDir = resolve(arg('--api-dir', 'apps/api'));
  const port = arg('--port', process.env['SMOKE_PORT'] ?? '3000');
  if (!existsSync(join(apiDir, 'dist', 'server.js'))) {
    console.error(`FAIL: ${join(apiDir, 'dist', 'server.js')} does not exist: build the API first (apps/api/Dockerfile's steps).`);
    process.exit(1);
  }
  if (!process.env['NODE_ENV'] || process.env['NODE_ENV'] === 'production') {
    console.error('FAIL: set a non-production NODE_ENV for the smoke (CI uses loadtest); production needs real providers and its own database identity.');
    process.exit(1);
  }

  const procs = [];
  let failure = null;
  try {
    // 1. modules
    const modules = new Proc('module loader', process.execPath, [fileURLToPath(import.meta.url), '--phase', 'modules', '--api-dir', apiDir], { cwd: apiDir, env: process.env });
    procs.push(modules);
    const timer = setTimeout(() => modules.child.kill('SIGKILL'), BOUND_MS.modules);
    await modules.done;
    clearTimeout(timer);
    for (const line of modules.lines) console.log(line);
    if (modules.exited.code !== 0) throw new SmokeFailure(`modules: the compiled API does not load (${modules.describeExit()})`);

    // 2-4. the API and the worker, side by side, as in deploy/docker-compose.yml
    const api = new Proc('API (node dist/server.js)', process.execPath, ['dist/server.js'], {
      cwd: apiDir,
      env: { ...process.env, RUN_WORKERS: '0', PORT: port, HOST: '127.0.0.1' },
    });
    const worker = new Proc('worker (node dist/worker.js)', process.execPath, ['dist/worker.js'], {
      cwd: apiDir,
      env: { ...process.env, RUN_WORKERS: '1' },
    });
    procs.push(api, worker);
    const base = `http://127.0.0.1:${port}`;

    await until('api: GET /health = 200', BOUND_MS.health, [api, worker], async () => {
      const code = await status(`${base}/health`);
      return code === 200 ? true : `HTTP ${code ?? 'no answer'}`;
    });
    await until('worker: heartbeat probe exits 0', BOUND_MS.worker, [api, worker], async () => {
      const probe = new Proc('worker probe', process.execPath, ['-e', "require('./dist/boot/worker-probe.js').main()"], { cwd: apiDir, env: process.env });
      const result = await Promise.race([probe.done, sleep(15_000).then(() => null)]);
      if (result === null) {
        probe.child.kill('SIGKILL');
        return 'probe timed out';
      }
      return result.code === 0 ? true : `probe ${probe.describeExit()}`;
    });
    await until('api: GET /ready = 200', BOUND_MS.ready, [api, worker], async () => {
      const code = await status(`${base}/ready`);
      return code === 200 ? true : `HTTP ${code ?? 'no answer'}`;
    });

    // 5. stop, as a container stop does
    for (const proc of [api, worker]) proc.child.kill('SIGTERM');
    const stopped = await Promise.race([Promise.all([api.done, worker.done]), sleep(BOUND_MS.stop).then(() => null)]);
    if (stopped === null) throw new SmokeFailure(`stop: SIGTERM did not end ${[api, worker].filter((p) => !p.exited).map((p) => p.name).join(' and ')} within ${BOUND_MS.stop / 1000} s`);
    for (const proc of [api, worker]) {
      if (proc.exited.code !== 0) throw new SmokeFailure(`stop: ${proc.name} ended with ${proc.describeExit()} after SIGTERM (expected exit code 0)`);
    }
    console.log('stop: both processes exited 0 after SIGTERM');
  } catch (error) {
    failure = error;
  } finally {
    for (const proc of procs) {
      if (!proc.exited) proc.child.kill('SIGKILL');
    }
  }

  if (failure) {
    console.error(`\nFAIL ${failure instanceof SmokeFailure ? failure.message : firstLine(failure)}`);
    for (const proc of procs.slice(1)) console.error(proc.tail());
    process.exit(1);
  }
  console.log('\nOK: the compiled API and worker load, boot, serve, become ready and stop cleanly.');
  // The bounds' timers (still pending after the races they lost) must not hold the job open.
  process.exit(0);
}

if (arg('--phase', '') === 'modules') {
  loadEveryModule(arg('--api-dir', 'apps/api'));
} else {
  await main();
}
