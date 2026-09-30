import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [STG-DRILLS] The staging-only drill scripts (deploy/drill-*.sh), run for real
// under bash against shims for docker, git and id — the pattern of
// deploy/tests/*.py, held here where CI runs it. Each refuses, before any
// container is touched, unless it is the staging pilot with the drill marker
// set in deploy/.env AND in the running worker; the job trigger names only its
// allowlist; the fixture script files the manifest the entry printed.
// ---------------------------------------------------------------------------

const DEPLOY = join(process.cwd(), '../../deploy');
const SHA = 'a'.repeat(40);
const STAGING_ENV = 'PILOT_ENV=staging\nNODE_ENV=loadtest\nSWIFT_STAGING_DRILLS=1\nAPI_HOST=api-staging.example.org\n';
const WORKER_ENV = 'NODE_ENV=loadtest\nPILOT_ENV=staging\nSWIFT_STAGING_DRILLS=1';
const python = spawnSync('python3', ['--version']);

let tmp = '';
let log = '';
let results = '';

function shim(name: string, body: string) {
  const path = join(tmp, 'bin', name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'drill-scripts-'));
  mkdirSync(join(tmp, 'deploy'));
  mkdirSync(join(tmp, 'bin'));
  for (const f of ['drill-common.sh', 'drill-fixtures.sh', 'drill-run-job.sh', 'drill-crash.sh']) {
    copyFileSync(join(DEPLOY, f), join(tmp, 'deploy', f));
    chmodSync(join(tmp, 'deploy', f), 0o755);
  }
  writeFileSync(join(tmp, 'deploy', '.env'), STAGING_ENV);
  log = join(tmp, 'calls');
  writeFileSync(log, '');
  results = join(tmp, 'results');
  shim('id', 'if [ "$1" = "-u" ]; then echo "${FAKE_UID:-1000}"; else echo "uid=1000"; fi');
  shim('git', 'echo "$GIT_HEAD"');
  shim('docker', [
    'echo "docker $*" >> "$CALL_LOG"',
    'case "$*" in',
    '  *"ps -q worker"*) echo wid123 ;;',
    '  *"{{.Config.Image}}"*) echo "$WORKER_IMAGE" ;;',
    '  *"Config.Env"*) printf "%s\\n" "$WORKER_ENV" ;;',
    '  *"drill-fixtures.js create"*) echo "a log line"; printf "%s\\n" "$MANIFEST_LINE"; exit "${EXEC_STATUS:-0}" ;;',
    '  *"drill-fixtures.js cleanup"*) echo "a log line"; echo \'{"removed":{"users":6},"kept":[],"tenant":"removed"}\'; exit "${EXEC_STATUS:-0}" ;;',
    '  *"drill-run-job.js"*) echo \'{"runs":[]}\'; exit "${EXEC_STATUS:-0}" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function run(script: string, args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${join(tmp, 'bin')}:${process.env['PATH']}`,
    HOME: tmp,
    CALL_LOG: log,
    GIT_HEAD: SHA,
    WORKER_IMAGE: `swift-api:${SHA}`,
    WORKER_ENV,
    JOURNEYS_RESULTS_DIR: results,
    ...extra,
  };
  return spawnSync('bash', [join(tmp, 'deploy', script), ...args], { env, encoding: 'utf8', timeout: 30_000 });
}
const calls = () => readFileSync(log, 'utf8');
const manifestLine = (runId: string) => JSON.stringify({ version: 1, runId, marker: `DRILL-${runId}` });

describe.skipIf(python.status !== 0)('[STG-DRILLS] drill-run-job.sh', () => {
  it('runs the allowlisted jobs, in order, inside the worker container', () => {
    const r = run('drill-run-job.sh', ['convert-trials', 'billing-cycle']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toMatch(/exec -T worker node dist\/boot\/drill-run-job\.js convert-trials billing-cycle/);
  });

  it('a job outside the allowlist, or none, is a usage error before anything is touched', () => {
    for (const args of [['process-billing'], [], ['billing-cycle', 'rm -rf /']]) {
      const r = run('drill-run-job.sh', args);
      expect(r.status, JSON.stringify(args)).toBe(2);
    }
    expect(calls()).toBe('');
  });

  it('refuses without the marker in deploy/.env, off the staging pilot, or in production — no container touched', () => {
    for (const env of [
      'PILOT_ENV=staging\nNODE_ENV=loadtest\n',
      'PILOT_ENV=staging\nNODE_ENV=loadtest\nSWIFT_STAGING_DRILLS=0\n',
      'PILOT_ENV=production\nNODE_ENV=loadtest\nSWIFT_STAGING_DRILLS=1\n',
      'PILOT_ENV=staging\nNODE_ENV=production\nSWIFT_STAGING_DRILLS=1\n',
    ]) {
      writeFileSync(join(tmp, 'deploy', '.env'), env);
      const r = run('drill-run-job.sh', ['settlement-digest']);
      expect(r.status, env).toBe(1);
      expect(r.stderr).toMatch(/FATAL/);
    }
    expect(calls()).not.toMatch(/exec -T/);
  });

  it('refuses when the RUNNING worker lacks the marker (a .env edit without a recreate)', () => {
    const r = run('drill-run-job.sh', ['settlement-digest'], { WORKER_ENV: 'NODE_ENV=loadtest\nPILOT_ENV=staging' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the running worker does not carry SWIFT_STAGING_DRILLS=1');
    expect(calls()).not.toMatch(/exec -T/);
  });

  it('refuses a worker that is not the checked-out revision, and the root user', () => {
    expect(run('drill-run-job.sh', ['settlement-digest'], { WORKER_IMAGE: 'swift-api:other' }).status).toBe(1);
    const root = run('drill-run-job.sh', ['settlement-digest'], { FAKE_UID: '0' });
    expect(root.status).toBe(1);
    expect(root.stderr).toContain('non-root');
    expect(calls()).not.toMatch(/exec -T/);
  });

  it('the entry’s own refusal is its exit status', () => {
    expect(run('drill-run-job.sh', ['settlement-digest'], { EXEC_STATUS: '3' }).status).toBe(3);
  });
});

describe.skipIf(python.status !== 0)('[STG-DRILLS] drill-fixtures.sh', () => {
  it('create files the manifest (the last stdout line) and passes the run id and admin phone', () => {
    const r = run('drill-fixtures.sh', ['create', 'stg-1'], { LIVETEST_ADMIN_PHONE: '+5920400000', MANIFEST_LINE: manifestLine('stg-1') });
    expect(r.status, r.stderr).toBe(0);
    const file = join(results, 'drills', 'stg-1', 'drill-manifest.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, runId: 'stg-1', marker: 'DRILL-stg-1' });
    expect(calls()).toMatch(/exec -T worker node dist\/boot\/drill-fixtures\.js create --run-id stg-1 --admin-phone \+5920400000/);
    expect(r.stdout).toContain(`LIVETEST_DRILL_MANIFEST=${file}`);
  });

  it('create refuses a live or missing admin phone and a bad run id before anything is touched', () => {
    expect(run('drill-fixtures.sh', ['create', 'stg-1']).status).toBe(1);
    expect(run('drill-fixtures.sh', ['create', 'stg-1'], { LIVETEST_ADMIN_PHONE: '+5926001000' }).status).toBe(1);
    expect(run('drill-fixtures.sh', ['create', 'bad id!'], { LIVETEST_ADMIN_PHONE: '+5920400000' }).status).toBe(1);
    expect(run('drill-fixtures.sh', ['explode', 'stg-1']).status).toBe(2);
    expect(calls()).toBe('');
  });

  it('a refused or failed entry files no manifest', () => {
    const r = run('drill-fixtures.sh', ['create', 'stg-2'], { LIVETEST_ADMIN_PHONE: '+5920400000', MANIFEST_LINE: manifestLine('stg-2'), EXEC_STATUS: '3' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('exit 3');
    expect(existsSync(join(results, 'drills', 'stg-2', 'drill-manifest.json'))).toBe(false);
  });

  it('a manifest for another run is refused', () => {
    const r = run('drill-fixtures.sh', ['create', 'stg-3'], { LIVETEST_ADMIN_PHONE: '+5920400000', MANIFEST_LINE: manifestLine('someone-else') });
    expect(r.status).toBe(1);
    expect(existsSync(join(results, 'drills', 'stg-3', 'drill-manifest.json'))).toBe(false);
  });

  it('cleanup files its report and exits with the entry’s status (1 when something was kept)', () => {
    const ok = run('drill-fixtures.sh', ['cleanup', 'stg-1']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(results, 'drills', 'stg-1', 'drill-cleanup.json'), 'utf8'))).toMatchObject({ kept: [], tenant: 'removed' });
    expect(run('drill-fixtures.sh', ['cleanup', 'stg-1'], { EXEC_STATUS: '1' }).status).toBe(1);
  });

  it('refuses without the marker, like every drill script', () => {
    writeFileSync(join(tmp, 'deploy', '.env'), 'PILOT_ENV=staging\nNODE_ENV=loadtest\n');
    expect(run('drill-fixtures.sh', ['create', 'stg-1'], { LIVETEST_ADMIN_PHONE: '+5920400000' }).status).toBe(1);
    expect(calls()).toBe('');
  });
});

describe.skipIf(python.status !== 0)('[STG-DRILLS D7] drill-crash.sh', () => {
  it('refuses without the run id, a live admin phone or the marker — before any container is touched', () => {
    expect(run('drill-crash.sh', [], { LIVETEST_ADMIN_PHONE: '+5920400000' }).status).toBe(1);
    expect(run('drill-crash.sh', [], { LIVETEST_RUN_ID: 'stg-1', LIVETEST_ADMIN_PHONE: '+5926001000' }).status).toBe(1);
    writeFileSync(join(tmp, 'deploy', '.env'), 'PILOT_ENV=staging\nNODE_ENV=loadtest\n');
    expect(run('drill-crash.sh', [], { LIVETEST_RUN_ID: 'stg-1', LIVETEST_ADMIN_PHONE: '+5920400000' }).status).toBe(1);
    expect(calls()).not.toMatch(/kill|start|up -d/);
  });

  it('kills with SIGKILL only after the setup reached mid-offer, waits 15 s, starts the same container, then verifies', () => {
    const s = readFileSync(join(DEPLOY, 'drill-crash.sh'), 'utf8');
    const at = (needle: string) => { const i = s.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at('"${RUNNER[@]}" --phase=setup')).toBeLessThan(at('docker kill "$WORKER_ID"'));
    expect(at('[ -s "$RESULTS/crash-drill-state.json" ]')).toBeLessThan(at('docker kill "$WORKER_ID"'));
    expect(at('docker kill "$WORKER_ID"')).toBeLessThan(at('sleep 15'));
    expect(at('sleep 15')).toBeLessThan(at('docker start "$WORKER_ID" >/dev/null\nRESTARTED_AT'));
    expect(at('RESTARTED_AT')).toBeLessThan(at('"${RUNNER[@]}" --phase=verify'));
  });

  it('whatever stops it, the exit trap starts the worker again and removes the private instance', () => {
    const s = readFileSync(join(DEPLOY, 'drill-crash.sh'), 'utf8');
    const cleanup = s.slice(s.indexOf('cleanup() {'), s.indexOf('trap cleanup EXIT'));
    expect(cleanup).toContain('worker_running || docker start "$WORKER_ID"');
    expect(cleanup).toContain('rm --stop --force api-journeys');
    expect(s.indexOf('trap cleanup EXIT')).toBeLessThan(s.indexOf('docker kill "$WORKER_ID"'));
    // The runner half has no Docker socket: only this host script touches containers.
    expect(s).toContain('--entrypoint apps/api/node_modules/.bin/tsx journeys scripts/livetest/run.ts --suite=crash-drill');
  });
});

describe('[STG-DRILLS] journeys-run.sh passes the manifest through, backward compatible', () => {
  const s = readFileSync(join(DEPLOY, 'journeys-run.sh'), 'utf8');
  const compose = readFileSync(join(DEPLOY, 'docker-compose.journeys.yml'), 'utf8');

  it('a manifest is validated, copied into the run results and handed to the runner by its /results path', () => {
    expect(s).toContain('DRILL_MANIFEST="${LIVETEST_DRILL_MANIFEST:-}"');
    expect(s).toContain('cp "$DRILL_MANIFEST" "$RESULTS/drill-manifest.json"');
    expect(s).toContain('export LIVETEST_DRILL_MANIFEST=/results/drill-manifest.json');
    expect(compose).toMatch(/^ {6}LIVETEST_DRILL_MANIFEST: \$\{LIVETEST_DRILL_MANIFEST:-\}$/m);
  });

  it('without a manifest the runner gets an empty value — the run is exactly as before', () => {
    expect(s).toMatch(/else\n\s+export LIVETEST_DRILL_MANIFEST=""\nfi/);
  });
});
