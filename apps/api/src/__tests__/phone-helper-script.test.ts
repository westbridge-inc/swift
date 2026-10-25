import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [PHONE-HELPER] deploy/phone-helper.sh, run for real under bash against shims
// for docker, git, curl and id (the pattern of staging-drill-scripts.test.ts).
// It is the host half of the helper's guard: the checks journeys-run.sh makes
// (the staging pilot, the checked-out revision everywhere, the isolation
// contract, the public route proofs) refuse before the private instance is
// started or any helper command runs; the private instance must be up and
// private for a command; stop cleans up and removes it.
// ---------------------------------------------------------------------------

const DEPLOY = join(process.cwd(), '../../deploy');
const SHA = 'b'.repeat(40);
const STAGING_ENV = 'PILOT_ENV=staging\nNODE_ENV=loadtest\nAPI_HOST=api-staging.example.org\n';
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
  tmp = mkdtempSync(join(tmpdir(), 'phone-helper-'));
  mkdirSync(join(tmp, 'deploy'));
  mkdirSync(join(tmp, 'bin'));
  mkdirSync(join(tmp, 'state'));
  copyFileSync(join(DEPLOY, 'phone-helper.sh'), join(tmp, 'deploy', 'phone-helper.sh'));
  chmodSync(join(tmp, 'deploy', 'phone-helper.sh'), 0o755);
  // The isolation proof is journeys-run.sh's own script; here a stand-in with a settable verdict.
  writeFileSync(join(tmp, 'deploy', 'verify-journeys-isolation.py'), 'import os, sys\nsys.exit(int(os.environ.get("ISO_STATUS", "0")))\n');
  writeFileSync(join(tmp, 'deploy', '.env'), STAGING_ENV);
  log = join(tmp, 'calls');
  writeFileSync(log, '');
  results = join(tmp, 'results');
  shim('id', 'case "$1" in -u) echo "${FAKE_UID:-1000}" ;; -g) echo 1000 ;; *) echo "uid=1000" ;; esac');
  shim('git', 'echo "$GIT_HEAD"');
  shim('curl', [
    'echo "curl $*" >> "$CALL_LOG"',
    'case "$*" in',
    '  *test-control/identity*) echo "${PUBLIC_TC_CODE:-404}" ;;',
    '  *verify-otp*) body="${PUBLIC_OTP_BODY:-}"; [ -n "$body" ] || body=\'{"success":false,"error":{"code":"INVALID_OTP"}}\'; echo "$body" ;;',
    'esac',
  ].join('\n'));
  shim('docker', [
    'echo "docker $*" >> "$CALL_LOG"',
    'case "$*" in',
    '  "image inspect"*) exit "${IMAGE_STATUS:-0}" ;;',
    '  *"ps -q api-journeys"*) [ -f "$STATE_DIR/up" ] && echo pj1; exit 0 ;;',
    '  *"ps -q api"*) echo api1 ;;',
    '  *"{{.Config.Image}}"*) echo "$API_IMAGE" ;;',
    '  *"{{.State.Health.Status}}"*) echo "${HEALTH:-healthy}" ;;',
    '  "port "*) printf "%s" "${PORTS:-}" ;;',
    '  *"config --format json"*) echo "{}" ;;',
    '  *" up -d "*) touch "$STATE_DIR/up" ;;',
    '  *"rm --stop --force api-journeys"*) rm -f "$STATE_DIR/up" ;;',
    '  *"phone-helper-run.ts"*) args="$*"; echo "helper ran with: ${args##*phone-helper-run.ts }"; exit "${HELPER_STATUS:-0}" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${join(tmp, 'bin')}:${process.env['PATH']}`,
    HOME: tmp,
    CALL_LOG: log,
    STATE_DIR: join(tmp, 'state'),
    GIT_HEAD: SHA,
    API_IMAGE: `swift-api:${SHA}`,
    JOURNEYS_RESULTS_DIR: results,
    LIVETEST_ADMIN_PHONE: '+5920400000',
    ...extra,
  };
  return spawnSync('bash', [join(tmp, 'deploy', 'phone-helper.sh'), ...args], { env, encoding: 'utf8', timeout: 30_000 });
}
const calls = () => readFileSync(log, 'utf8');
const started = () => existsSync(join(tmp, 'state', 'up'));

describe.skipIf(python.status !== 0)('[PHONE-HELPER] deploy/phone-helper.sh', () => {
  it('no mode, or an unknown one, is a usage error before anything is touched', () => {
    for (const args of [[], ['admin', 'approve'], ['rm -rf /']]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(2);
    }
    expect(calls()).toBe('');
  });

  it('the host guard refuses off the staging pilot, in production, as root or without a +5920 admin — before any container or request', () => {
    const cases: Array<[Record<string, string>, string | null, RegExp]> = [
      [{}, 'PILOT_ENV=production\nNODE_ENV=loadtest\nAPI_HOST=api-staging.example.org\n', /staging pilot/],
      [{}, 'PILOT_ENV=staging\nNODE_ENV=production\nAPI_HOST=api-staging.example.org\n', /production never hosts it/],
      [{}, 'PILOT_ENV=staging\nNODE_ENV=loadtest\nAPI_HOST=not a host\n', /API_HOST/],
      [{ FAKE_UID: '0' }, null, /non-root/],
      [{ LIVETEST_ADMIN_PHONE: '+5926001234' }, null, /LIVETEST_ADMIN_PHONE/],
      [{ LIVETEST_ADMIN_PHONE: '' }, null, /LIVETEST_ADMIN_PHONE/],
    ];
    for (const [extra, envFile, why] of cases) {
      writeFileSync(join(tmp, 'deploy', '.env'), envFile ?? STAGING_ENV);
      writeFileSync(log, '');
      for (const mode of [['start'], ['store', 'open']]) {
        const r = run(mode, extra);
        expect(r.status, `${JSON.stringify(extra)} ${mode.join(' ')}`).toBe(1);
        expect(r.stderr).toMatch(why);
      }
      expect(calls()).toBe('');
    }
  });

  it('refuses a revision mismatch, a missing image, a broken isolation contract, or a public API that exposes test control', () => {
    for (const [extra, why] of [
      [{ API_IMAGE: 'swift-api:other' }, /not the checked-out revision/],
      [{ IMAGE_STATUS: '1' }, /is not built/],
      [{ ISO_STATUS: '1' }, /isolation check failed/],
      [{ PUBLIC_TC_CODE: '200' }, /TEST_CONTROL_ENABLED is on/],
    ] as Array<[Record<string, string>, RegExp]>) {
      writeFileSync(log, '');
      for (const mode of [['start'], ['customer', 'codes']]) {
        const r = run(mode, extra);
        expect(r.status, JSON.stringify(extra)).toBe(1);
        expect(r.stderr).toMatch(why);
      }
      expect(calls()).not.toMatch(/ up -d | run --rm /);
      expect(started()).toBe(false);
    }
  });

  it('start proves the dev code is refused on the public route; a command does not re-probe it (the OTP rate limit) but still proves test control is off', () => {
    const r = run(['start'], { PUBLIC_OTP_BODY: '{"success":true,"data":{"tokens":{}}}' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('did not refuse the dev OTP code');
    expect(started()).toBe(false);

    writeFileSync(log, '');
    expect(run(['start']).status).toBe(0);
    const startCalls = calls();
    expect(startCalls).toContain('test-control/identity');
    expect(startCalls).toContain('verify-otp');

    writeFileSync(log, '');
    expect(run(['store', 'open']).status).toBe(0);
    expect(calls()).toContain('test-control/identity');
    expect(calls()).not.toContain('verify-otp');
  });

  it('start brings up the private instance and waits for it to be healthy; a published port is refused and the instance removed', () => {
    const ok = run(['start']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(calls()).toMatch(/up -d --no-deps --no-build --pull never api-journeys/);
    expect(ok.stdout).toContain('phone helper ready');
    expect(started()).toBe(true);

    rmSync(join(tmp, 'state', 'up'));
    const exposed = run(['start'], { PORTS: '3000/tcp -> 0.0.0.0:3000' });
    expect(exposed.status).toBe(1);
    expect(exposed.stderr).toContain('published port');
    expect(started()).toBe(false);
  });

  it('a command needs the private instance up and private, then runs ONE helper command in the runner container and logs it', () => {
    const cold = run(['store', 'open', '--at', '6.8013,-58.1551']);
    expect(cold.status).toBe(1);
    expect(cold.stderr).toContain('run ./deploy/phone-helper.sh start first');
    expect(calls()).not.toMatch(/run --rm/);

    expect(run(['start']).status).toBe(0);
    writeFileSync(log, '');
    const r = run(['store', 'open', '--at', '6.8013,-58.1551']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toMatch(/run --rm --no-deps --pull never --entrypoint apps\/api\/node_modules\/\.bin\/tsx journeys scripts\/livetest\/phone-helper-run\.ts store open --at 6\.8013,-58\.1551/);
    expect(r.stdout).toContain('helper ran with: store open --at 6.8013,-58.1551');
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const logged = readFileSync(join(results, 'phone-helper', `${day}.log`), 'utf8');
    expect(logged).toContain('phone-helper store open --at 6.8013,-58.1551');
    expect(logged).toContain('helper ran with: store open --at 6.8013,-58.1551');

    const exposed = run(['store', 'open'], { PORTS: '3000/tcp -> 0.0.0.0:3000' });
    expect(exposed.status).toBe(1);
    expect(exposed.stderr).toContain('published port');
  });

  it('the helper’s own exit status is the script’s (e.g. its target refusal, 3)', () => {
    expect(run(['start']).status).toBe(0);
    expect(run(['rider', 'accept'], { HELPER_STATUS: '3' }).status).toBe(3);
    expect(run(['rider', 'accept'], { HELPER_STATUS: '1' }).status).toBe(1);
  });

  it('stop cleans every helper account up through the helper, then removes the private instance', () => {
    expect(run(['start']).status).toBe(0);
    writeFileSync(log, '');
    const r = run(['stop']);
    expect(r.status, r.stderr).toBe(0);
    const c = calls();
    expect(c.indexOf('phone-helper-run.ts all cleanup')).toBeGreaterThan(-1);
    expect(c.indexOf('phone-helper-run.ts all cleanup')).toBeLessThan(c.indexOf('rm --stop --force api-journeys'));
    expect(started()).toBe(false);
    // Stopping again, with nothing up, only removes (idempotent).
    writeFileSync(log, '');
    expect(run(['stop']).status).toBe(0);
    expect(calls()).not.toContain('phone-helper-run.ts');
  });
});

describe('[PHONE-HELPER] the script mirrors journeys-run.sh’s host guard', () => {
  it('every refusal journeys-run.sh makes before it starts anything, phone-helper.sh makes too', () => {
    const journeys = readFileSync(join(DEPLOY, 'journeys-run.sh'), 'utf8');
    const helper = readFileSync(join(DEPLOY, 'phone-helper.sh'), 'utf8');
    for (const check of [
      '[ "$(id -u)" -ne 0 ]',
      '[ "$(env_value PILOT_ENV)" = staging ]',
      '[ "$(env_value NODE_ENV)" = loadtest ]',
      '[[ "${LIVETEST_ADMIN_PHONE:-}" =~ ^\\+5920[0-9]{6}$ ]]',
      'docker image inspect "swift-api:$SHA"',
      '[ "$(docker inspect -f \'{{.Config.Image}}\' "$API_ID")" = "swift-api:$SHA" ]',
      'python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" --require-journeys',
      '"https://$API_HOST/api/v1/test-control/identity"',
      '[ "$code" = 404 ]',
      '\'{"phone":"+5920499999","code":"000000"}\'',
    ]) {
      expect(journeys, `journeys-run.sh: ${check}`).toContain(check);
      expect(helper, `phone-helper.sh: ${check}`).toContain(check);
    }
  });
});
