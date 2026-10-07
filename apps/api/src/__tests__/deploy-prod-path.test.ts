import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
if argv[:2] == ["context", "show"]:
    print(os.environ.get("DOCKER_CURRENT_CONTEXT", "default"))
    sys.exit(0)
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
    if os.environ.get("PS_FAIL") == "1":
        sys.exit(1)
    service = argv[-1]
    if service in ("api", "worker") and os.environ.get("API_STOPPED") == "1":
        sys.exit(0)
    print(service + "-id")
sys.exit(0)
`;

// getent ahostsv4 NAME → the address DNS_MAP gives it ("name=ip;name=ip").
// getent ahostsv6 NAME → the AAAA addresses DNS6_MAP gives it ("name=a,b;…"),
// and, as glibc does, the IPv4-mapped form of its A address besides.
const FAKE_GETENT = String.raw`import os, sys
no_addrconfig = "-A" in sys.argv or "--no-addrconfig" in sys.argv
sys.argv = [arg for arg in sys.argv if arg not in ("-A", "--no-addrconfig")]
pairs = dict(p.split("=", 1) for p in os.environ.get("DNS_MAP", "").split(";") if "=" in p)
pairs6 = dict(p.split("=", 1) for p in os.environ.get("DNS6_MAP", "").split(";") if "=" in p)
if sys.argv[1:2] == ["ahostsv4"]:
    found = [pairs[sys.argv[2]]] if sys.argv[2] in pairs else []
elif sys.argv[1:2] == ["ahostsv6"]:
    if os.environ.get("GETENT6_STATUS"):
        sys.exit(int(os.environ["GETENT6_STATUS"]))
    if os.environ.get("IPV4_ONLY") == "1" and not no_addrconfig:
        sys.exit(2)
    found = [a for a in pairs6.get(sys.argv[2], "").split(",") if a] + (["::ffff:" + pairs[sys.argv[2]]] if sys.argv[2] in pairs else [])
else:
    sys.exit(2)
if not found:
    sys.exit(2)
for ip in found:
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
  // Production also requires the public origins the API hands out (#1448 review).
  API_PUBLIC_URL: `https://${PROD_HOST}`, APP_PUBLIC_URL: 'https://example.org',
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
/** Every call that changes the stack: a compose up, stop or build, or a systemctl. */
const changedNothing = (lines: string[]) => lines.filter((l) => /^docker compose .* (up|stop|build)( |$)/.test(l) || l.startsWith('systemctl '));

describe('[PROD-PATH] the test helper that finds stack-changing calls', () => {
  it('finds a compose up, stop or build and a systemctl, and nothing else (positive control)', () => {
    expect(changedNothing([
      'docker compose --project-directory /x -f /x/docker-compose.yml build api',
      'docker compose --project-directory /x -f /x/docker-compose.yml up -d --wait postgres redis meilisearch',
      'docker compose --project-directory /x -f /x/docker-compose.yml stop api worker',
      'systemctl restart swift-secrets.service',
      'docker compose --project-directory /x -f /x/docker-compose.yml config --quiet',
      'docker compose --project-directory /x -f /x/docker-compose.yml ps -q api',
      'docker network inspect swift-pilot-private',
      'git fetch origin main',
    ])).toHaveLength(4);
  });
});

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

describe('[PROD-PATH] pilot-up.sh checks the configuration Compose will actually use', () => {
  it.each([
    ['NODE_ENV', 'development'],
    ['WEB_HOST', 'staging.example.org'],
    ['WEB_ALLOW_SITE_TOKENS', '1'],
    ['STORAGE_PROVIDER', 'local'],
    ['API_HOST', 'api-staging.example.org'],
    ['COMPOSE_PROFILES', 'web'],
    ['COMPOSE_PROJECT_NAME', 'other'],
  ])('refuses %s exported in the shell (Compose would prefer it to deploy/.env), before anything runs', (name, value) => {
    const r = runPilot(PRODUCTION, { env: { [name]: value } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${name} is set in this shell`);
    expect(r.calls).toEqual([]);
  });

  it('refuses it on staging too, and an exported empty value counts', () => {
    const r = runPilot(STAGING, { env: { NODE_ENV: '' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV is set in this shell');
  });

  it('the names it sets itself (SWIFT_TAG, SWIFT_WEB_CHANNEL) do not count', () => {
    const r = runPilot(PRODUCTION, { env: { SWIFT_TAG: 'old', SWIFT_WEB_CHANNEL: 'staging' } });
    expect(r.status, r.stderr).toBe(0);
  });

  it('every name Compose interpolates in the stack files is covered (the guard reads them from the files)', () => {
    const names = [...new Set([...COMPOSE_TEXT.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))].filter((n) => !['SWIFT_TAG', 'SWIFT_WEB_CHANNEL'].includes(n));
    expect(names).toEqual(expect.arrayContaining(['NODE_ENV', 'API_HOST', 'WEB_HOST', 'WEB_ALLOW_SITE_TOKENS', 'POSTGRES_USER']));
    for (const name of names) {
      writeFileSync(log, '');
      const r = runPilot(PRODUCTION, { env: { [name]: 'x' } });
      expect(r.status, name).not.toBe(0);
      expect(r.stderr, name).toContain(`${name} is set in this shell`);
    }
  });
});

describe('[PROD-PATH] deploy/.env is read once, the way Compose reads it: one plain line per name', () => {
  const asFile = (lines: string[]) => lines.join('\n') + '\n';
  const PROD_LINES = Object.entries(PRODUCTION).map(([k, v]) => `${k}=${v}`);
  function runPilotRaw(text: string, opts: { args?: string[] } = {}) {
    const here = preparePilot();
    writeFileSync(join(here, '.env'), text);
    const res = spawnSync('bash', [join(here, 'pilot-up.sh'), ...(opts.args ?? [SHA])], {
      encoding: 'utf8', timeout: 120_000,
      env: { PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, CALL_LOG: log, GIT_HEAD: SHA, STORE_NAMES: STORE.join(' '),
        HOST_IPS: `${HOST_IP} `, DNS_MAP: `${PROD_HOST}=${HOST_IP}` },
    });
    return { ...res, calls: calls() };
  }
  it.each([
    ['a duplicate NODE_ENV (Compose takes the last)', [...PROD_LINES, 'NODE_ENV=development'], 'NODE_ENV is set twice'],
    ['an export line', [...PROD_LINES, 'export WEB_ALLOW_SITE_TOKENS=1'], 'is not a plain NAME=value setting'],
    ['an indented setting', [...PROD_LINES, '  WEB_HOST=staging.example.org'], 'is not a plain NAME=value setting'],
    ['a YAML-style setting', [...PROD_LINES, 'WEB_HOST: staging.example.org'], 'is not a plain NAME=value setting'],
  ])('pilot-up refuses %s, before anything runs, naming no value', (_what, lines, message) => {
    const r = runPilotRaw(asFile(lines));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
    expect(r.stderr).not.toContain('development');
    expect(r.calls).toEqual([]);
  });
  it('comments, blank and indented comment lines are fine', () => {
    const r = runPilotRaw(asFile(['# settings', '', '   # indented comment', ...PROD_LINES]));
    expect(r.status, r.stderr).toBe(0);
  });
  it('seed-production refuses a duplicate or exported setting too', () => {
    for (const extra of ['NODE_ENV=development', 'export NODE_ENV=development']) {
      writeFileSync(log, '');
      const here = join(tmp, 'repo', 'deploy');
      mkdirSync(here, { recursive: true });
      for (const f of ['seed-production.sh', 'docker-compose.seed.yml', 'docker-compose.yml']) copyFileSync(join(DEPLOY, f), join(here, f));
      writeFileSync(join(here, '.env'), asFile(['PILOT_ENV=production', 'NODE_ENV=production', extra]));
      const r = spawnSync('bash', [join(here, 'seed-production.sh'), SHA], { encoding: 'utf8', env: {
        PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, CALL_LOG: log, GIT_HEAD: SHA, SEED_ADMIN_PHONE: '+5920400000', SEED_FX_GYD_PER_USD: '209' } });
      expect(r.status, extra).not.toBe(0);
      expect(r.stderr, extra).toMatch(/is set twice|is not a plain NAME=value setting/);
      expect(calls(), extra).toEqual([]);
    }
  });
  it.each(['uat.example.org', 'api.test.example.org', 'sandbox-api.example.org', 'dev.example.org', 'api.qa.example.org', 'demo-1.example.org'])(
    'production refuses the test-environment name %s', (name) => {
      const r = runPilot({ ...PRODUCTION, API_HOST: name }, { env: { DNS_MAP: `${name}=${HOST_IP}` } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('test-environment name');
      expect(r.calls).toEqual([]);
    },
  );
  it('ordinary production names are not mistaken for test ones', () => {
    for (const name of ['api.example.org', 'contest.example.org', 'developer-api.example.org']) {
      writeFileSync(log, '');
      const r = runPilot({ ...PRODUCTION, API_HOST: name, API_PUBLIC_URL: `https://${name}` }, { env: { DNS_MAP: `${name}=${HOST_IP}` } });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
  });
});

describe('[PROD-PATH · #1448 review] pilot-up.sh: one Docker daemon, the production public origins, IPv6 too', () => {
  it.each(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'])('refuses %s exported in the shell (Docker would act on another daemon), before anything runs, on staging too', (name) => {
    for (const settings of [PRODUCTION, STAGING]) {
      writeFileSync(log, '');
      const r = runPilot(settings, { env: { [name]: name === 'DOCKER_HOST' ? 'ssh://elsewhere.example.org' : 'other' } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`${name} is set in this shell, and Docker would act on another daemon`);
      expect(r.calls).toEqual([]);
    }
  });

  it('production refuses a Docker context other than this host\'s own, before the stack changes', () => {
    const r = runPilot(PRODUCTION, { env: { DOCKER_CURRENT_CONTEXT: 'remote-box' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("docker's current context is not this host's own daemon");
    expect(changedNothing(r.calls)).toEqual([]);
    expect(r.calls.filter((l) => l.startsWith('git '))).toEqual([]);
  });

  it.each([
    [{ API_PUBLIC_URL: undefined }, 'API_PUBLIC_URL'],
    [{ API_PUBLIC_URL: `http://${PROD_HOST}` }, 'API_PUBLIC_URL'],
    [{ API_PUBLIC_URL: 'https://api-other.example.org' }, 'API_PUBLIC_URL'],
    [{ API_PUBLIC_URL: `https://${PROD_HOST}/v1` }, 'API_PUBLIC_URL'],
    [{ API_PUBLIC_URL: `https://${PROD_HOST}:8443` }, 'API_PUBLIC_URL'],
    [{ APP_PUBLIC_URL: undefined }, 'APP_PUBLIC_URL'],
    [{ APP_PUBLIC_URL: 'http://example.org' }, 'APP_PUBLIC_URL'],
    [{ APP_PUBLIC_URL: 'https://localhost' }, 'APP_PUBLIC_URL'],
    [{ APP_PUBLIC_URL: 'https://203.0.113.10' }, 'APP_PUBLIC_URL'],
    [{ APP_PUBLIC_URL: 'https://staging.example.org' }, 'staging name staging.example.org'],
    [{ APP_PUBLIC_URL: 'https://uat.example.org' }, 'test-environment name uat.example.org'],
    [{ CORS_ORIGIN: undefined }, 'CORS_ORIGIN'],
    [{ CORS_ORIGIN: 'http://example.org' }, 'CORS_ORIGIN entry http://example.org'],
    [{ CORS_ORIGIN: 'https://example.org,http://localhost:3000' }, 'CORS_ORIGIN entry http://localhost:3000'],
    [{ CORS_ORIGIN: '*' }, 'CORS_ORIGIN entry *'],
    [{ CORS_ORIGIN: 'https://example.org,https://staging.example.org' }, 'staging name staging.example.org'],
    [{ CORS_ORIGIN: 'https://example.org,https://dev.example.org' }, 'test-environment name dev.example.org'],
  ])('production refuses %j before anything runs', (over, named) => {
    const r = runPilot({ ...PRODUCTION, ...over });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(named);
    expect(r.calls).toEqual([]);
  });

  it('production accepts its public origins with a trailing slash, and several https CORS origins', () => {
    const r = runPilot({ ...PRODUCTION, API_PUBLIC_URL: `https://${PROD_HOST}/`, APP_PUBLIC_URL: 'https://example.org/', CORS_ORIGIN: 'https://example.org, https://www.example.org' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('staging keeps its own origins (the production checks are production\'s)', () => {
    const r = runPilot({ ...STAGING, API_PUBLIC_URL: undefined, APP_PUBLIC_URL: undefined, CORS_ORIGIN: 'http://localhost:3000' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('production refuses a served name whose IPv6 (AAAA) address is not this host\'s, before anything runs; this host\'s own IPv6 passes', () => {
    const elsewhere = runPilot(PRODUCTION, { env: { DNS6_MAP: `${PROD_HOST}=2001:db8::99` } });
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.stderr).toContain(`${PROD_HOST} resolves to 2001:db8::99, which is not this host`);
    expect(elsewhere.calls).toEqual([]);
    writeFileSync(log, '');
    const here = runPilot(PRODUCTION, { env: { DNS6_MAP: `${PROD_HOST}=2001:DB8::10`, HOST_IPS: `${HOST_IP} 10.10.0.5 2001:db8::10 ` } });
    expect(here.status, here.stderr).toBe(0);
  });

  it('an IPv4-only host still detects stale AAAA records without address-family filtering', () => {
    const stale = runPilot(PRODUCTION, { env: { IPV4_ONLY: '1', DNS6_MAP: `${PROD_HOST}=2001:db8::99` } });
    expect(stale.status, stale.stdout).not.toBe(0);
    expect(stale.stderr).toContain(`${PROD_HOST} resolves to 2001:db8::99, which is not this host`);
    expect(stale.calls).toEqual([]);
    writeFileSync(log, '');
    const noAAAA = runPilot(PRODUCTION, { env: { IPV4_ONLY: '1', DNS6_MAP: '' } });
    expect(noAAAA.status, noAAAA.stderr).toBe(0);
  });

  it('refuses when the unfiltered IPv6 query cannot run', () => {
    const r = runPilot(PRODUCTION, { env: { GETENT6_STATUS: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('cannot check');
    expect(r.calls).toEqual([]);
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

  it('fails CLOSED when Docker cannot say whether the API is running: no migration without that answer', () => {
    const r = runPilot(PRODUCTION, { args: ['--data-only', SHA], env: { DNS_MAP: '', API_STOPPED: '1', PS_FAIL: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('could not ask Docker whether api is running');
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
  copyFileSync(join(DEPLOY, 'docker-compose.yml'), join(here, 'docker-compose.yml'));
  writeFileSync(join(here, '.env'), Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  shim('docker', [
    'line="$*"',
    'echo "docker $line [approvals=${SEED_PLAN_APPROVALS:-}] [promotion=${SEED_PROMOTION_APPROVALS:-}] [keyfile=${SEED_APPROVER_KEYS_FILE:-}]" >> "$CALL_LOG"',
    'case "$line" in "context show") echo "${DOCKER_CURRENT_CONTEXT:-default}"; exit 0;; esac',
    'case "$line" in *"exec -T postgres"*) echo "$IDENTITY_ROW"; exit 0;; esac',
    'exit 0',
  ].join('\n'));
  const res = spawnSync('bash', [join(here, 'seed-production.sh'), SHA], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`,
      CALL_LOG: log, GIT_HEAD: SHA, STORE_NAMES: 'POSTGRES_PASSWORD SEED_APPROVER_KEYS',
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
  it('standalone production seed refuses a persisted remote Docker context before querying the database', () => {
    const r = runSeed(PROD_SEED, { DOCKER_CURRENT_CONTEXT: 'remote-box' });
    expect(r.status, r.stdout).not.toBe(0);
    expect(r.stderr).toContain("docker's current context is not this host's own daemon");
    expect(r.calls).toEqual(['docker context show [approvals=] [promotion=] [keyfile=]']);
  });
  it('seeds a production database from the production host', () => {
    const r = runSeed(PROD_SEED);
    expect(r.status, r.stderr).toBe(0);
    expect(seeded(r.calls)).toBe(true);
  });

  it.each(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'])('refuses %s exported in the shell (another daemon), before Docker is asked anything', (name) => {
    const r = runSeed(PROD_SEED, { [name]: 'other' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${name} is set in this shell, and Docker would act on another daemon`);
    expect(r.calls).toEqual([]);
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

  it('a staging host seeds only a database that says exactly staging', () => {
    for (const row of ['1:production', '1:test', '1: ', '1:Staging', '1:staging ']) {
      writeFileSync(log, '');
      const r = runSeed(STG_SEED, { IDENTITY_ROW: row });
      expect(r.status, row).not.toBe(0);
      expect(r.stderr, row).toContain('is not staging');
      expect(seeded(r.calls), row).toBe(false);
    }
    writeFileSync(log, '');
    const ok = runSeed(STG_SEED, { IDENTITY_ROW: '1:staging' });
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('refuses a Compose-interpolated setting exported in the shell, but takes the ceremony inputs from it', () => {
    const r = runSeed(PROD_SEED, { NODE_ENV: 'development' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('NODE_ENV is set in this shell');
    expect(r.calls).toEqual([]);
    writeFileSync(log, '');
    const ok = runSeed(PROD_SEED, { SEED_ACTOR: 'operator' });
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

  it('approvals reach the seed with the pinned approver keys as a file, never a value', () => {
    const approvals = '[{"approver":"alice","request":"cg==","signature":"cw=="}]';
    const apply = runSeed(PROD_SEED, { SEED_PLAN_APPROVALS: approvals });
    expect(apply.status, apply.stderr).toBe(0);
    const applied = apply.calls.find((l) => l.includes('run --rm --no-TTY seed'))!;
    expect(applied).toContain(`[approvals=${approvals}]`);
    expect(applied).toContain('[keyfile=/run/secrets/SEED_APPROVER_KEYS]');
    expect(apply.calls).toContain('systemctl restart swift-secrets.service');
    writeFileSync(log, '');
    const promote = runSeed(PROD_SEED, { SEED_PROMOTION_APPROVALS: approvals });
    expect(promote.status, promote.stderr).toBe(0);
    expect(promote.calls.find((l) => l.includes('run --rm --no-TTY seed'))).toContain('[keyfile=/run/secrets/SEED_APPROVER_KEYS]');
    writeFileSync(log, '');
    const plain = runSeed(PROD_SEED);
    expect(plain.calls.find((l) => l.includes('run --rm --no-TTY seed'))).toContain('[keyfile=]');
  });

  it('approvals refuse without the pinned keys in the store', () => {
    const r = runSeed(PROD_SEED, { SEED_PLAN_APPROVALS: '[]', STORE_NAMES: 'POSTGRES_PASSWORD' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('SEED_APPROVER_KEYS');
    expect(seeded(r.calls)).toBe(false);
  });

  it('the seed service carries the ceremony settings with empty defaults, and no shared signing key', () => {
    const seed = readFileSync(join(DEPLOY, 'docker-compose.seed.yml'), 'utf8');
    expect(seed).toContain('SEED_APPROVER_KEYS_FILE: ${SEED_APPROVER_KEYS_FILE:-}');
    expect(seed).toContain('SEED_PLAN_APPROVALS: ${SEED_PLAN_APPROVALS:-}');
    expect(seed).toContain('SEED_PROMOTION_APPROVALS: ${SEED_PROMOTION_APPROVALS:-}');
    expect(seed).not.toMatch(/SEED_PLAN_SECRET|SEED_SIGN_/);
    expect(readFileSync(join(DEPLOY, 'seed-production.sh'), 'utf8')).not.toMatch(/SEED_PLAN_SECRET|SEED_SIGN_/);
  });
});

// ── restore.sh --compare-source, against REAL databases ────────────────────
// The compare SQL runs for real on the test cluster: a source database with
// RLS, a policy, a trigger, a function, a grant, a sequence and the swift_qr
// schema is dumped with the real pg_dump; restore.sh restores it with the real
// pg_restore into a scratch database and compares the two with its own SQL.
// Only `docker compose exec postgres` is a stand-in: it runs the same command
// on this host against the same server.
const PGURL = new URL(process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test');
const PG = { port: PGURL.port || '5432', user: decodeURIComponent(PGURL.username), password: decodeURIComponent(PGURL.password) };
const pgEnv = () => ({ PATH: process.env['PATH'] ?? '', PGHOST: '127.0.0.1', PGPORT: PG.port, PGUSER: PG.user, PGPASSWORD: PG.password });
function psql(db: string, sql: string): string {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-qtA', '-d', db, '-c', sql], { env: pgEnv(), encoding: 'utf8' });
}
const FIXTURE = String.raw`
CREATE SCHEMA swift_qr;
CREATE TABLE public.users (id text PRIMARY KEY, balance numeric(12,2) NOT NULL DEFAULT 0, status text NOT NULL);
CREATE TABLE public.platform_config (id text PRIMARY KEY, key text UNIQUE NOT NULL, value jsonb, "updatedAt" timestamp(3) NOT NULL);
CREATE TABLE swift_qr.tokens (token text PRIMARY KEY, vendor text NOT NULL);
CREATE SEQUENCE public.ticket_seq;
SELECT nextval('public.ticket_seq');
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.users USING (status <> 'hidden');
CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch();
GRANT SELECT ON public.users TO PUBLIC;
INSERT INTO public.users VALUES ('u1', 100.00, 'ACTIVE'), ('u2', 0, 'SUSPENDED');
INSERT INTO public.platform_config VALUES ('c1', 'fee', '1', '2026-10-05 00:00:00');
INSERT INTO swift_qr.tokens VALUES ('t1', 'v1');
`;
const created: string[] = [];
afterEach(() => {
  for (const db of created.splice(0)) {
    try { psql('postgres', `DROP DATABASE IF EXISTS ${db}`); } catch { /* best effort */ }
  }
});

/** Build a source database, dump it for real, change it with `after` (or not),
 *  then run the real restore.sh against it. */
function drill(after: string | null, opts: { args?: string[]; fixture?: string } = {}) {
  const id = Math.random().toString(36).slice(2, 10);
  const source = `swift_test_rcmp_${id}`;
  const scratch = `swift_test_rscr_${id}`;
  created.push(source, scratch);
  psql('postgres', `CREATE DATABASE ${source}`);
  psql(source, opts.fixture ?? FIXTURE);
  const here = join(tmp, 'deploy');
  mkdirSync(here, { recursive: true });
  copyFileSync(join(DEPLOY, 'restore.sh'), join(here, 'restore.sh'));
  writeFileSync(join(here, '.env'), `POSTGRES_DB=${source}\n`);
  const dump = join(tmp, `${id}.dump`);
  execFileSync('pg_dump', ['-Fc', '-d', source, '-f', dump], { env: pgEnv() });
  if (after) psql(source, after);
  writeFileSync(join(tmp, 'pgpass'), PG.password);
  shim('docker', [
    'echo "docker $*" >> "$CALL_LOG"',
    'while [ $# -gt 0 ] && [ "$1" != postgres ]; do shift; done',
    '[ $# -gt 0 ] || exit 0',
    'shift',
    'export POSTGRES_USER="$PG_USER" POSTGRES_PASSWORD_FILE="$PG_PASSFILE" PGPORT="$PG_PORT"',
    'exec "$@"',
  ].join('\n'));
  const res = spawnSync('bash', [join(here, 'restore.sh'), ...(opts.args ?? ['--compare-source']), dump, scratch], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, CALL_LOG: log, PG_USER: PG.user, PG_PASSFILE: join(tmp, 'pgpass'), PG_PORT: PG.port },
  });
  return { ...res, source, scratch };
}

describe('[PROD-PATH] restore.sh --compare-source proves contents, on real databases', { timeout: 120_000 }, () => {
  it('passes an exact copy (no user table needed), summarises both sides and says exactly what it proved', () => {
    const r = drill(null);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/source \(swift_test_rcmp_\w+\): 3 tables, 4 rows, \d+ columns, RLS enabled on 1, forced on 1, 1 policies, \d+ constraints, \d+ indexes, 1 triggers, 1 functions, \d+ grant entries, 1 sequences/);
    expect(r.stdout).toContain('in schemas public and swift_qr the scratch restore equals its source in every table\'s row count and content checksum, column definitions and defaults, RLS switches, policies, constraints, indexes, triggers, function definitions, grants and sequence positions');
    expect(r.stdout).toContain('RESTORE OK');
  });

  it.each([
    ['a changed value with the same row count', `UPDATE public.users SET balance = 99 WHERE id = 'u1'`, 'rows|public.users|2|'],
    ['a changed row in swift_qr', `UPDATE swift_qr.tokens SET vendor = 'v2'`, 'rows|swift_qr.tokens|1|'],
    ['a changed column default', `ALTER TABLE public.users ALTER COLUMN balance SET DEFAULT 5`, 'column|public.users|balance|'],
    ['a changed function body', `CREATE OR REPLACE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status := upper(NEW.status); RETURN NEW; END $$`, 'function|public.touch()|'],
    ['a disabled trigger', `ALTER TABLE public.users DISABLE TRIGGER users_touch`, 'users_touch'],
    ['a revoked grant', `REVOKE SELECT ON public.users FROM PUBLIC`, 'grant|relation|public.users|'],
    ['an advanced sequence', `SELECT nextval('public.ticket_seq')`, 'sequence|public.ticket_seq|'],
    ['an RLS switch turned off', `ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY`, 'rls|public.users|'],
    ['a dropped policy', `DROP POLICY tenant_isolation ON public.users`, 'policy|public.users|tenant_isolation'],
  ])('fails on %s, names it, and keeps the scratch database', (_what, change, named) => {
    const r = drill(change);
    expect(r.status, r.stdout).not.toBe(0);
    expect(r.stdout).toContain('MISMATCH');
    expect(r.stdout).toContain(named);
    expect(r.stderr).toContain('scratch database retained');
    expect(r.stdout).not.toContain('RESTORE OK');
  });

  it('a backup heartbeat written after the dump is not a difference', () => {
    const r = drill(`INSERT INTO public.platform_config VALUES ('hb', 'last_backup_at', '"2026-10-05"', now())`);
    expect(r.status, r.stderr + r.stdout).toBe(0);
  });

  it('fails when the source has no tables to compare', () => {
    const r = drill(null, { fixture: 'SELECT 1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no tables to compare');
  });

  it('without the flag the fixed minimums still apply: a database without users fails them', () => {
    const r = drill(null, { args: [], fixture: 'CREATE TABLE country_configs (code text); INSERT INTO country_configs VALUES (\'GY\'); CREATE TABLE users (id text); CREATE TABLE vendors (id text); CREATE TABLE orders (id text);' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('users: 0 (below 1)');
  });

  it('still refuses the live database as the scratch target, in either mode, before touching Postgres', () => {
    const here = join(tmp, 'deploy');
    mkdirSync(here, { recursive: true });
    copyFileSync(join(DEPLOY, 'restore.sh'), join(here, 'restore.sh'));
    writeFileSync(join(here, '.env'), 'POSTGRES_DB=swift\n');
    writeFileSync(join(tmp, 'x.dump'), 'dump');
    for (const args of [['--compare-source', join(tmp, 'x.dump'), 'swift'], [join(tmp, 'x.dump'), 'swift']]) {
      writeFileSync(log, '');
      const r = spawnSync('bash', [join(here, 'restore.sh'), ...args], { encoding: 'utf8', env: { PATH: `${join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, CALL_LOG: log } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('may not be the live database');
      expect(calls()).toEqual([]);
    }
  });
});
