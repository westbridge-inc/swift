import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [TASK-057] The staging journey suite needs an API that accepts the dev OTP
// code (DEV_OTP_BYPASS=1) and answers /test-control (TEST_CONTROL_ENABLED=1).
// That API is PRIVATE: deploy/docker-compose.journeys.yml adds `api-journeys`
// (the public api's image, settings and secret mounts, plus the two switches)
// and a one-shot `journeys` runner — neither publishes a port, both sit only
// on swift-pilot-private, and Caddy never routes to them. The PUBLIC api
// never carries either switch. deploy/verify-journeys-isolation.py enforces
// this on the rendered model in pilot-up.sh and deploy/journeys-run.sh; the
// python contract (deploy/tests/test_journeys_isolation.py) is not run by CI,
// so this suite holds the same line where CI can see it.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

const OVERRIDE = read('deploy/docker-compose.journeys.yml');
const BASE = read('deploy/docker-compose.yml');
const CADDYFILE = read('deploy/Caddyfile');
const PILOT_UP = read('deploy/pilot-up.sh');
const RUN_SCRIPT = read('deploy/journeys-run.sh');
const CHECKER = join(ROOT, 'deploy/verify-journeys-isolation.py');

const serviceBlock = (source: string, name: string) => {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const next = lines.slice(start + 1).findIndex((line) => /^ {2}[\w-]+:|^[a-z]+:/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : start + 1 + next).join('\n');
};

describe('[TASK-057] the journey services are private', () => {
  it('both journey services exist, behind the journeys profile', () => {
    for (const name of ['api-journeys', 'journeys']) {
      const block = serviceBlock(OVERRIDE, name);
      expect(block, `${name} is missing from deploy/docker-compose.journeys.yml`).not.toBe('');
      expect(block, `${name} must carry the journeys profile`).toContain('profiles: [journeys]');
    }
  });

  it('neither publishes a port, uses another network or runs privileged', () => {
    for (const name of ['api-journeys', 'journeys']) {
      const block = serviceBlock(OVERRIDE, name);
      expect(block, `${name} publishes a port`).not.toMatch(/^ {4}(ports|expose):/m);
      expect(block, `${name} leaves the private network`).not.toMatch(/^ {4}network_mode:/m);
      expect(block, `${name} is privileged`).not.toMatch(/^ {4}privileged:/m);
      expect(block, `${name} is not on the private network only`).toContain('networks: [private]');
    }
  });

  it('api-journeys is the public api plus the two switches, its secret a file', () => {
    const block = serviceBlock(OVERRIDE, 'api-journeys');
    expect(block).toMatch(/extends:\n\s+file: docker-compose\.yml\n\s+service: api\n/);
    expect(block).toContain('DEV_OTP_BYPASS: "1"');
    expect(block).toContain('TEST_CONTROL_ENABLED: "1"');
    expect(block).toContain('TEST_CONTROL_SECRET_FILE: /run/secrets/TEST_CONTROL_SECRET');
    expect(OVERRIDE, 'TEST_CONTROL_SECRET must never be a value').not.toMatch(/^\s+TEST_CONTROL_SECRET:/m);
  });

  it('api-journeys sends nothing out: SMS, email and push pinned to the in-memory dev adapters', () => {
    const block = serviceBlock(OVERRIDE, 'api-journeys');
    for (const name of ['NOTIFICATION_PROVIDER', 'EMAIL_PROVIDER', 'PUSH_PROVIDER']) {
      expect(block, `${name} must be pinned to dev`).toMatch(new RegExp(`^ {6}${name}: dev$`, 'm'));
    }
  });

  it('the runner targets only api-journeys and holds no secret', () => {
    const block = serviceBlock(OVERRIDE, 'journeys');
    expect(block).toContain('LIVETEST_BASE_URL: http://api-journeys:3000');
    expect(block).not.toContain('env_file');
    expect(block).not.toContain('/run/secrets');
    expect(block).not.toContain('docker.sock');
  });

  it('the public api and worker never carry the switches, and Caddy never routes to a journey service', () => {
    for (const name of ['api', 'worker', 'migrate', 'caddy']) {
      const block = serviceBlock(BASE, name);
      expect(block, `${name} is missing from deploy/docker-compose.yml`).not.toBe('');
      expect(block, `${name} carries DEV_OTP_BYPASS`).not.toContain('DEV_OTP_BYPASS');
      expect(block, `${name} carries TEST_CONTROL_ENABLED`).not.toContain('TEST_CONTROL_ENABLED');
    }
    expect(CADDYFILE).not.toMatch(/journeys/);
  });

  it('pilot-up and the run script both check the rendered model', () => {
    const verify = PILOT_UP.slice(PILOT_UP.indexOf('verify_private_ports() {'), PILOT_UP.indexOf('\nverify_private_ports\n'));
    expect(verify).toContain('verify-journeys-isolation.py');
    expect(verify).toContain('docker-compose.journeys.yml');
    expect(verify).toContain('--require-journeys');
    expect(RUN_SCRIPT).toContain('verify-journeys-isolation.py');
    expect(RUN_SCRIPT).toContain('rm --stop --force api-journeys');
    expect(RUN_SCRIPT).toContain('/api/v1/test-control/identity');
  });
});

describe('[TASK-057] the isolation checker refuses', () => {
  // A value that must never appear in the checker's output (the rendered model inlines deploy/.env).
  const MARKER = 'value-that-must-not-print';
  const image = 'swift-api:journeys-fixture';
  const net = { private: null };
  const model = () => ({
    networks: { private: { name: 'swift-pilot-private', external: true } },
    services: {
      api: { image, environment: { NODE_ENV: 'loadtest', POSTGRES_PASSWORD: MARKER }, networks: net },
      worker: { image, environment: { NODE_ENV: 'loadtest' }, networks: net },
      caddy: { image: 'caddy:2.10', networks: net, ports: [{ target: 80, published: '80', protocol: 'tcp' }, { target: 443, published: '443', protocol: 'tcp' }] },
      'api-journeys': {
        image,
        environment: {
          NODE_ENV: 'loadtest', DEV_OTP_BYPASS: '1', TEST_CONTROL_ENABLED: '1', TEST_CONTROL_SECRET_FILE: '/run/secrets/TEST_CONTROL_SECRET',
          NOTIFICATION_PROVIDER: 'dev', EMAIL_PROVIDER: 'dev', PUSH_PROVIDER: 'dev',
        },
        networks: net,
      },
      journeys: { image, environment: { LIVETEST_BASE_URL: 'http://api-journeys:3000' }, networks: net, volumes: [] as unknown[] },
    } as Record<string, any>,
  });
  const python = spawnSync('python3', ['--version']);
  const run = (m: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'journeys-caddy-'));
    try {
      const caddy = join(dir, 'Caddyfile');
      writeFileSync(caddy, CADDYFILE);
      return spawnSync('python3', [CHECKER, caddy, '--require-journeys'], { input: JSON.stringify(m), encoding: 'utf8', timeout: 20_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.skipIf(python.status !== 0)('accepts the intended model', () => {
    const r = run(model());
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(python.status !== 0)('a journey service with a published port', () => {
    for (const name of ['api-journeys', 'journeys']) {
      const m = model();
      m.services[name].ports = [{ target: 3000, published: '3001', protocol: 'tcp' }];
      const r = run(m);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`${name} publishes a host port`);
    }
  });

  it.skipIf(python.status !== 0)('a journey service on a second network', () => {
    const m = model();
    (m.networks as Record<string, unknown>)['edge'] = { name: 'swift-edge' };
    m.services['api-journeys'].networks = { private: null, edge: null };
    const r = run(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('swift-pilot-private only');
  });

  it.skipIf(python.status !== 0)('the public api carrying either switch — without printing a value', () => {
    for (const sw of ['DEV_OTP_BYPASS', 'TEST_CONTROL_ENABLED']) {
      const m = model();
      m.services['api'].environment[sw] = '1';
      const r = run(m);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`api carries ${sw}`);
      expect(r.stdout + r.stderr).not.toContain(MARKER);
    }
  });

  it.skipIf(python.status !== 0)('a private instance whose SMS, email or push could send', () => {
    for (const [name, live] of [['NOTIFICATION_PROVIDER', 'twilio'], ['EMAIL_PROVIDER', 'smtp'], ['PUSH_PROVIDER', 'expo']] as const) {
      const m = model();
      m.services['api-journeys'].environment[name] = live;
      const r = run(m);
      expect(r.status, name).toBe(1);
      expect(r.stderr).toContain(`must pin ${name}=dev`);
    }
  });

  it.skipIf(python.status !== 0)('a runner that carries anything but LIVETEST_* settings', () => {
    const m = model();
    m.services['journeys'].environment['EXTRA_SETTING'] = MARKER;
    const r = run(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('LIVETEST_* settings only');
    expect(r.stdout + r.stderr).not.toContain(MARKER);
  });
});
