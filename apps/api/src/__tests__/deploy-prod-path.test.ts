import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [PROD-PATH] The production target of the deploy scripts, run for real under
// bash against shims (docker, git, curl, sudo, the secret store, systemctl,
// getent, hostname). Nothing is deployed. Owner ruling, 4 Oct 2026: write a
// real production target with production-specific guards — never run staging
// as production — plus a database-only stage, the seed ceremony's plan half,
// and a restore drill that compares against its source.
//   pilot-up.sh         PILOT_ENV=production: NODE_ENV=production, no staging
//                       name, documents off this disk, backup keys stored, no
//                       unfilled site details, DNS already on this host; the
//                       website built on the production channel; --data-only.
//   seed-production.sh  the database's own identity must agree with the host;
//                       the plan approvals reach the seed with the key file.
//   restore.sh          --compare-source: the scratch copy must equal its source.
// ---------------------------------------------------------------------------

const DEPLOY = join(process.cwd(), '../../deploy');
const SHA = 'c'.repeat(40);
const PROD_HOST = 'api.example.org';
const HOST_IP = '203.0.113.10';

let tmp = '';
let log = '';

function shim(name: string, body: string, shebang = '#!/bin/sh') {
  const path = join(tmp, 'bin', name);
  writeFileSync(path, `${shebang}\n${body}\n`);
  chmodSync(path, 0o755);
}
const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const indexOf = (lines: string[], fragment: string) => lines.findIndex((l) => l.includes(fragment));

// A docker stand-in: logs every call (with the web channel it was given), and
// answers compose config / ps / inspect the way a healthy stack would.
const FAKE_DOCKER = String.raw`import json, os, sys
argv = sys.argv[1:]
line = " ".join(argv)
with open(os.environ["CALL_LOG"], "a") as log:
    channel = os.environ.get("SWIFT_WEB_CHANNEL", "")
    log.write("docker " + line + (" [channel=" + channel + "]" if " build " in " " + line + " " else "") + "\n")
if argv[:1] == ["network"]:
    if "-f" in argv:
        print("bridge")
    sys.exit(0)
if argv[:1] == ["inspect"]:
    fmt = argv[2]
    print("exited 0" if "ExitCode" in fmt else ("healthy" if "Health" in fmt else "running"))
    sys.exit(0)
if argv[:1] == ["compose"] and "config" in argv and "--format" in argv:
    if any(a.endswith("docker-compose.routing.yml") for a in argv):
        print(json.dumps({"services": {"osrm": {}}}))
    else:
        services = {n: {} for n in ("postgres", "redis", "meilisearch", "migrate", "api", "worker")}
        services["caddy"] = {"ports": [{"published": "80", "target": 80, "protocol": "tcp"}, {"published": "443", "target": 443, "protocol": "tcp"}]}
        for profile in ("web", "admin"):
            if "--profile" in argv and profile in [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--profile"]:
                services[profile] = {}
        print(json.dumps({"services": services}))
    sys.exit(0)
if argv[:1] == ["compose"] and "ps" in argv and "-q" in argv:
    service = argv[-1]
    if service in ("api", "worker") and os.environ.get("API_STOPPED") == "1":
        sys.exit(0)
    print(service + "-id")
sys.exit(0)
`;

// getent ahostsv4 NAME → the address DNS_MAP gives it ("name=ip;name=ip").
const FAKE_GETENT = String.raw`import os, sys
if sys.argv[1:2] != ["ahostsv4"]:
    sys.exit(2)
pairs = dict(p.split("=", 1) for p in os.environ.get("DNS_MAP", "").split(";") if "=" in p)
ip = pairs.get(sys.argv[2])
if not ip:
    sys.exit(2)
print(ip + "      STREAM " + sys.argv[2])
print(ip + "      DGRAM")
`;

function baseShims() {
  writeFileSync(join(tmp, 'bin', 'docker'), `#!/usr/bin/env python3\n${FAKE_DOCKER}`);
  chmodSync(join(tmp, 'bin', 'docker'), 0o755);
  writeFileSync(join(tmp, 'bin', 'getent'), `#!/usr/bin/env python3\n${FAKE_GETENT}`);
  chmodSync(join(tmp, 'bin', 'getent'), 0o755);
  shim('git', 'echo "git $*" >> "$CALL_LOG"\n[ "$*" = "rev-parse HEAD" ] && echo "$GIT_HEAD"\nexit 0');
  shim('curl', 'echo "curl $*" >> "$CALL_LOG"\nexit 0');
  shim('id', 'if [ "$1" = "-u" ]; then echo 1000; else echo "uid=1000"; fi');
  shim('sudo', 'echo "sudo $*" >> "$CALL_LOG"\n[ "$1" = -n ] && shift\nexec "$@"');
  shim('swift-secrets', '[ "$1" = list ] && printf "%s\\n" $STORE_NAMES\nexit 0');
  shim('systemctl', 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0');
  shim('hostname', '[ "$1" = "-I" ] && echo "$HOST_IPS"\nexit 0');
  shim('sleep', 'exit 0');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'prod-path-'));
  mkdirSync(join(tmp, 'bin'));
  log = join(tmp, 'calls');
  writeFileSync(log, '');
  baseShims();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// ── pilot-up.sh ─────────────────────────────────────────────────────────────
const COMPOSE_TEXT = readFileSync(join(DEPLOY, 'docker-compose.yml'), 'utf8');
const STORE = [...new Set([...COMPOSE_TEXT.matchAll(/_FILE: \/run\/secrets\/([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!)), 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].sort();

function preparePilot() {
  const here = join(tmp, 'repo', 'deploy');
  mkdirSync(join(here, 'routing-data', 'osrm'), { recursive: true });
  writeFileSync(join(here, 'routing-data', 'osrm', 'guyana-latest.osrm'), '');
  for (const f of ['pilot-up.sh', 'secret-names.sh', 'wait-for-migration.sh', 'verify-journeys-isolation.py', 'Caddyfile', 'docker-compose.yml', 'docker-compose.routing.yml']) {
    copyFileSync(join(DEPLOY, f), join(here, f));
  }
  mkdirSync(join(tmp, 'repo', 'apps', 'api', 'src', 'utils'), { recursive: true });
  copyFileSync(join(DEPLOY, '../apps/api/src/utils/secret-files.ts'), join(tmp, 'repo', 'apps', 'api', 'src', 'utils', 'secret-files.ts'));
  return here;
}

const PRODUCTION = {
  PILOT_ENV: 'production', NODE_ENV: 'production', API_HOST: PROD_HOST, MAPS_PROVIDER: 'osrm', OSRM_URL: 'http://osrm:5000',
  BACKUP_BUCKET: 'prod-backups', STORAGE_PROVIDER: 's3', CORS_ORIGIN: 'https://example.org',
};
const STAGING = { ...PRODUCTION, PILOT_ENV: 'staging', NODE_ENV: 'development', API_HOST: 'api-staging.example.org', STORAGE_PROVIDER: 'local', STORAGE_ALLOW_LOCAL: '1' };

function runPilot(settings: Record<string, string | undefined>, opts: { args?: string[]; env?: Record<string, string> } = {}) {
  const here = preparePilot();
  writeFileSync(join(here, '.env'), Object.entries(settings).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const res = spawnSync('bash', [join(here, 'pilot-up.sh'), ...(opts.args ?? [SHA])], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`,
      CALL_LOG: log, GIT_HEAD: SHA, STORE_NAMES: STORE.join(' '),
      HOST_IPS: `${HOST_IP} 10.10.0.5 `, DNS_MAP: `${PROD_HOST}=${HOST_IP};www.example.org=${HOST_IP};example.org=${HOST_IP}`,
      ...opts.env,
    },
  });
  return { ...res, calls: calls() };
}
const changedNothing = (lines: string[]) => lines.filter((l) => /^docker compose .*( up | stop | build )/.test(` ${l} `) || l.startsWith('systemctl '));

describe('[PROD-PATH] pilot-up.sh: a real production target', () => {
  it('staging deploys exactly as before', () => {
    const r = runPilot(STAGING);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`STAGING READY at exact SHA ${SHA}`);
  });

  it('production deploys the whole stack once its name resolves here, and says so', () => {
    const r = runPilot(PRODUCTION);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`PRODUCTION READY at exact SHA ${SHA}`);
    expect(indexOf(r.calls, 'stop api worker')).toBeGreaterThan(-1);
    expect(indexOf(r.calls, 'up -d --no-deps --force-recreate caddy')).toBeGreaterThan(-1);
  });

  it('the production website is built on the production channel, the staging website on the staging one', () => {
    const prod = runPilot({ ...PRODUCTION, WEB_HOST: 'example.org', CORS_ORIGIN: 'https://example.org' });
    expect(prod.status, prod.stderr).toBe(0);
    expect(prod.calls.find((l) => l.includes(' build web'))).toContain('[channel=production]');
    writeFileSync(log, '');
    const stg = runPilot({ ...STAGING, WEB_HOST: 'staging.example.org' });
    expect(stg.status, stg.stderr).toBe(0);
    expect(stg.calls.find((l) => l.includes(' build web'))).toContain('[channel=staging]');
  });

  it('the compose file takes the channel from the deploy, staging when unset', () => {
    expect(COMPOSE_TEXT).toContain('SWIFT_WEB_CHANNEL: ${SWIFT_WEB_CHANNEL:-staging}');
    expect(COMPOSE_TEXT).not.toMatch(/SWIFT_WEB_CHANNEL: staging\s*$/m);
  });

  it.each(['', 'prod', 'Production', 'development', 'production '])('refuses PILOT_ENV=%j before anything runs', (pilotEnv) => {
    const r = runPilot({ ...PRODUCTION, PILOT_ENV: pilotEnv });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('PILOT_ENV must be staging or production');
    expect(r.calls).toEqual([]);
  });

  it.each([undefined, 'development', 'loadtest', 'test', 'Production'])('production refuses NODE_ENV=%j before anything runs', (nodeEnv) => {
    const r = runPilot({ ...PRODUCTION, NODE_ENV: nodeEnv });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV=production');
    expect(r.calls).toEqual([]);
  });

  it.each([
    ['API_HOST', 'api-staging.example.org'],
    ['API_ALIAS_HOST', 'api.Staging.example.org'],
    ['WEB_HOST', 'staging.example.org'],
  ])('production refuses a staging name in %s before anything runs', (name, value) => {
    const r = runPilot({ ...PRODUCTION, [name]: value });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/staging name/);
    expect(r.calls).toEqual([]);
  });

  it.each([
    [{ STORAGE_PROVIDER: undefined }, 'STORAGE_PROVIDER'],
    [{ STORAGE_PROVIDER: 'local' }, 'STORAGE_PROVIDER'],
    [{ STORAGE_ALLOW_LOCAL: '1' }, 'STORAGE_ALLOW_LOCAL'],
    [{ WEB_ALLOW_SITE_TOKENS: '1' }, 'WEB_ALLOW_SITE_TOKENS'],
  ])('production refuses %j before anything runs', (over, named) => {
    const r = runPilot({ ...PRODUCTION, ...over });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(named);
    expect(r.calls).toEqual([]);
  });

  it('production refuses to start while its name does not resolve, or resolves elsewhere, before anything runs', () => {
    const unresolved = runPilot(PRODUCTION, { env: { DNS_MAP: '' } });
    expect(unresolved.status).not.toBe(0);
    expect(unresolved.stderr).toContain(`${PROD_HOST} does not resolve yet`);
    expect(unresolved.calls).toEqual([]);
    writeFileSync(log, '');
    const elsewhere = runPilot(PRODUCTION, { env: { DNS_MAP: `${PROD_HOST}=198.51.100.7` } });
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.stderr).toContain(`${PROD_HOST} resolves to 198.51.100.7, which is not this host`);
    expect(elsewhere.calls).toEqual([]);
    writeFileSync(log, '');
    const site = runPilot({ ...PRODUCTION, WEB_HOST: 'example.org' }, { env: { DNS_MAP: `${PROD_HOST}=${HOST_IP}` } });
    expect(site.status).not.toBe(0);
    expect(site.stderr).toContain('example.org does not resolve yet');
  });

  it('staging never asks DNS: its readiness check is the proof it always was', () => {
    const r = runPilot(STAGING, { env: { DNS_MAP: '' } });
    expect(r.status, r.stderr).toBe(0);
  });

  it('production refuses a store without the off-site backup keys, before the stack changes', () => {
    const r = runPilot(PRODUCTION, { env: { STORE_NAMES: STORE.filter((n) => n !== 'AWS_SECRET_ACCESS_KEY').join(' ') } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('AWS_SECRET_ACCESS_KEY is not in the encrypted store');
    expect(changedNothing(r.calls)).toEqual([]);
  });
});

describe('[PROD-PATH] pilot-up.sh --data-only: the database without the API', () => {
  it('migrates on production before DNS, and never starts, stops or builds the API, worker, website or Caddy', () => {
    const r = runPilot({ ...PRODUCTION, WEB_HOST: 'example.org' }, { args: ['--data-only', SHA], env: { DNS_MAP: '', API_STOPPED: '1' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`DATABASE READY at exact SHA ${SHA} (production; migrations applied; the API, worker and Caddy were not started)`);
    expect(r.stdout).not.toContain('PRODUCTION READY');
    expect(indexOf(r.calls, 'up -d --wait postgres redis meilisearch')).toBeGreaterThan(-1);
    const migrate = indexOf(r.calls, 'up -d --force-recreate migrate');
    expect(migrate).toBeGreaterThan(indexOf(r.calls, 'up -d --wait postgres redis meilisearch'));
    for (const forbidden of ['stop api worker', 'force-recreate api worker', 'force-recreate caddy', ' build web', ' build admin', 'force-recreate web']) {
      expect(r.calls.filter((l) => l.includes(forbidden)), forbidden).toEqual([]);
    }
    expect(r.calls.filter((l) => l.startsWith('curl '))).toEqual([]);
  });

  it('refuses while an API or worker is running, before anything is pulled or built', () => {
    const r = runPilot(PRODUCTION, { args: ['--data-only', SHA], env: { DNS_MAP: '' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('--data-only refuses a stack whose api is running');
    expect(r.calls.filter((l) => / (pull|build|up) /.test(` ${l} `))).toEqual([]);
  });

  it('keeps every production refusal: a staging posture is refused in the database-only stage too', () => {
    const r = runPilot({ ...PRODUCTION, NODE_ENV: 'development' }, { args: ['--data-only', SHA], env: { API_STOPPED: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
});

// ── seed-production.sh ──────────────────────────────────────────────────────
function runSeed(settings: Record<string, string>, env: Record<string, string> = {}) {
  const here = join(tmp, 'repo', 'deploy');
  mkdirSync(here, { recursive: true });
  copyFileSync(join(DEPLOY, 'seed-production.sh'), join(here, 'seed-production.sh'));
  copyFileSync(join(DEPLOY, 'docker-compose.seed.yml'), join(here, 'docker-compose.seed.yml'));
  writeFileSync(join(here, '.env'), Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  shim('docker', [
    'line="$*"',
    'echo "docker $line [plan=${SEED_SIGN_PLAN:-}] [approvals=${SEED_PLAN_APPROVALS:-}] [keyfile=${SEED_PLAN_SECRET_FILE:-}]" >> "$CALL_LOG"',
    'case "$line" in *"exec -T postgres"*) echo "$IDENTITY_ROW"; exit 0;; esac',
    'exit 0',
  ].join('\n'));
  const res = spawnSync('bash', [join(here, 'seed-production.sh'), SHA], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`,
      CALL_LOG: log, GIT_HEAD: SHA, STORE_NAMES: 'POSTGRES_PASSWORD SEED_PLAN_SECRET',
      SEED_ADMIN_PHONE: '+5920400000', IDENTITY_ROW: '1:production', SEED_FX_GYD_PER_USD: '209.5',
      ...env,
    },
  });
  return { ...res, calls: calls() };
}
const PROD_SEED = { PILOT_ENV: 'production', NODE_ENV: 'production' };
const STG_SEED = { PILOT_ENV: 'staging', NODE_ENV: 'development' };
const seeded = (lines: string[]) => lines.some((l) => l.includes('run --rm --no-TTY seed'));

describe('[PROD-PATH] seed-production.sh: the host and the database must agree', () => {
  it('seeds a production database from the production host', () => {
    const r = runSeed(PROD_SEED);
    expect(r.status, r.stderr).toBe(0);
    expect(seeded(r.calls)).toBe(true);
  });

  it('refuses to seed a database that is not production from the production host', () => {
    for (const row of ['1:staging', '1:test', '1: ', '1']) {
      writeFileSync(log, '');
      const r = runSeed(PROD_SEED, { IDENTITY_ROW: row });
      expect(r.status, row).not.toBe(0);
      expect(r.stderr).toContain('is not production');
      expect(seeded(r.calls)).toBe(false);
    }
  });

  it('a staging host never seeds a production database', () => {
    const r = runSeed(STG_SEED, { IDENTITY_ROW: '1:production' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('a staging host never seeds a production database');
    expect(seeded(r.calls)).toBe(false);
    writeFileSync(log, '');
    const ok = runSeed(STG_SEED, { IDENTITY_ROW: '1:staging' });
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('still refuses an unidentified database', () => {
    const r = runSeed(PROD_SEED, { IDENTITY_ROW: '0: ' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('deployment_identity');
  });

  it.each(['development', 'loadtest', ''])('production refuses NODE_ENV=%j before touching the database', (nodeEnv) => {
    const r = runSeed({ ...PROD_SEED, NODE_ENV: nodeEnv });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV=production');
    expect(r.calls).toEqual([]);
  });

  it.each(['', '0', '0.0', 'abc', '-209', '209,5'])('production refuses SEED_FX_GYD_PER_USD=%j before touching the database', (fx) => {
    const r = runSeed(PROD_SEED, { SEED_FX_GYD_PER_USD: fx });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SEED_FX_GYD_PER_USD');
    expect(r.calls).toEqual([]);
  });

  it.each(['abc', 'f'.repeat(63), 'F'.repeat(64)])('refuses a malformed plan digest to sign (%j)', (digest) => {
    const r = runSeed(PROD_SEED, { SEED_SIGN_PLAN: digest, SEED_SIGN_APPROVER: 'owner' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SEED_SIGN_PLAN');
    expect(seeded(r.calls)).toBe(false);
  });

  it('refuses a plan digest without the approver who signs it', () => {
    const r = runSeed(PROD_SEED, { SEED_SIGN_PLAN: 'a'.repeat(64) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SEED_SIGN_APPROVER');
  });

  it('plan signing and the plan apply reach the seed with the key as a file, never a value', () => {
    const sign = runSeed(PROD_SEED, { SEED_SIGN_PLAN: 'a'.repeat(64), SEED_SIGN_APPROVER: 'owner' });
    expect(sign.status, sign.stderr).toBe(0);
    const run = sign.calls.find((l) => l.includes('run --rm --no-TTY seed'))!;
    expect(run).toContain(`[plan=${'a'.repeat(64)}]`);
    expect(run).toContain('[keyfile=/run/secrets/SEED_PLAN_SECRET]');
    expect(sign.calls).toContain('systemctl restart swift-secrets.service');
    writeFileSync(log, '');
    const approvals = '[{"approver":"a","signature":"1"},{"approver":"b","signature":"2"}]';
    const apply = runSeed(PROD_SEED, { SEED_PLAN_APPROVALS: approvals });
    expect(apply.status, apply.stderr).toBe(0);
    const applied = apply.calls.find((l) => l.includes('run --rm --no-TTY seed'))!;
    expect(applied).toContain(`[approvals=${approvals}]`);
    expect(applied).toContain('[keyfile=/run/secrets/SEED_PLAN_SECRET]');
  });

  it('the plan apply refuses without the key in the store', () => {
    const r = runSeed(PROD_SEED, { SEED_PLAN_APPROVALS: '[]', STORE_NAMES: 'POSTGRES_PASSWORD' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SEED_PLAN_SECRET');
    expect(seeded(r.calls)).toBe(false);
  });

  it('the seed service carries both plan settings with empty defaults', () => {
    const seed = readFileSync(join(DEPLOY, 'docker-compose.seed.yml'), 'utf8');
    expect(seed).toContain('SEED_SIGN_PLAN: ${SEED_SIGN_PLAN:-}');
    expect(seed).toContain('SEED_PLAN_APPROVALS: ${SEED_PLAN_APPROVALS:-}');
  });
});

// ── restore.sh --compare-source ─────────────────────────────────────────────
const SNAPSHOT = [
  'constraint|orders|orders_pkey|PRIMARY KEY (id)',
  'index|orders|orders_pkey|CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
  'policy|orders|tenant_isolation|PERMISSIVE|{public}|ALL|("tenantId" = current_setting(\'app.tenant\'::text))|',
  'rls|orders|enabled=t|forced=t',
  'rls|users|enabled=t|forced=t',
  'rows|orders|0',
  'rows|users|0',
].join('\n');

function runRestore(args: string[], env: Record<string, string> = {}) {
  const here = join(tmp, 'deploy');
  mkdirSync(here, { recursive: true });
  copyFileSync(join(DEPLOY, 'restore.sh'), join(here, 'restore.sh'));
  writeFileSync(join(here, '.env'), 'POSTGRES_DB=swift\n');
  writeFileSync(join(tmp, 'live.snap'), env['LIVE'] ?? SNAPSHOT);
  writeFileSync(join(tmp, 'scratch.snap'), env['SCRATCH'] ?? SNAPSHOT);
  writeFileSync(join(tmp, 'x.dump'), 'dump');
  shim('pg_restore', 'exit 0');
  // db_psql passes: sh -c SCRIPT sh <database> <psql args…>
  shim('docker', [
    'echo "docker $*" >> "$CALL_LOG"',
    'db=""; prev=""; for a in "$@"; do if [ "$prev" = "sh" ] && [ -z "$db" ] && [ "$a" != "-c" ]; then db="$a"; fi; prev="$a"; done',
    'case "$*" in',
    '  *posture-snapshot*) if [ "$db" = swift ]; then cat "$SNAP_DIR/live.snap"; else cat "$SNAP_DIR/scratch.snap"; fi; exit 0;;',
    '  *"FROM pg_database"*) exit 0;;',
    '  *"SELECT count(*) FROM"*) echo "${COUNT:-0}"; exit 0;;',
    '  *pg_restore*) cat >/dev/null; exit 0;;',
    'esac',
    '[ -t 0 ] || cat >/dev/null',
    'exit 0',
  ].join('\n'));
  const res = spawnSync('bash', [join(here, 'restore.sh'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    input: '',
    env: { PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, CALL_LOG: log, SNAP_DIR: tmp, ...env },
  });
  return { ...res, calls: calls() };
}

describe('[PROD-PATH] restore.sh --compare-source: the drill judges the copy against its source', () => {
  it('passes an exact copy of an EMPTY database (no user yet), with its posture summarised', () => {
    const r = runRestore(['--compare-source', join(tmp, 'x.dump'), 'swift_restore_drill']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('source (swift): 2 tables, 0 rows, RLS enabled on 2, forced on 2, 1 policies, 1 constraints, 1 indexes');
    expect(r.stdout).toContain('scratch (swift_restore_drill): 2 tables, 0 rows');
    expect(r.stdout).toContain('matches its source exactly');
    expect(r.stdout).toContain('RESTORE OK');
    // The fixed minimums are not consulted in this mode.
    expect(r.stdout).not.toMatch(/^users: /m);
  });

  it.each([
    ['a row count', SNAPSHOT.replace('rows|users|0', 'rows|users|1'), 'rows|users|0'],
    ['a forced-RLS switch', SNAPSHOT.replace('rls|orders|enabled=t|forced=t', 'rls|orders|enabled=t|forced=f'), 'forced=t'],
    ['a missing policy', SNAPSHOT.split('\n').filter((l) => !l.startsWith('policy|')).join('\n'), 'tenant_isolation'],
  ])('fails on %s that differs, names it, and keeps the scratch database', (_what, scratch, named) => {
    const r = runRestore(['--compare-source', join(tmp, 'x.dump'), 'swift_restore_drill'], { SCRATCH: scratch });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('MISMATCH');
    expect(r.stdout).toContain(named);
    expect(r.stderr).toContain('scratch database retained');
    expect(r.stdout).not.toContain('RESTORE OK');
  });

  it('fails when the source has nothing to compare', () => {
    const r = runRestore(['--compare-source', join(tmp, 'x.dump'), 'swift_restore_drill'], { LIVE: '', SCRATCH: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no tables to compare');
  });

  it('without the flag the fixed minimums still apply: an empty database fails them', () => {
    const r = runRestore([join(tmp, 'x.dump'), 'swift_restore_drill'], { COUNT: '0' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('users: 0 (below 1)');
  });

  it('still refuses the live database as the scratch target, in either mode', () => {
    for (const args of [['--compare-source', join(tmp, 'x.dump'), 'swift'], [join(tmp, 'x.dump'), 'swift']]) {
      writeFileSync(log, '');
      const r = runRestore(args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('may not be the live database');
      expect(r.calls).toEqual([]);
    }
  });
});
