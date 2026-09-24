import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [TASK-057] The journey runner (scripts/livetest, --suite=journeys) signs in
// with the dev OTP code and then places orders and suspends users. It must
// REFUSE to start unless (a) the target is private — never the public
// hostname, a public DNS name or a public address; (b) the target serves
// /test-control/identity (production never does) and declares an environment
// other than production; (c) the data classification is synthetic; (p) every
// phone it creates, files or sends to is +5920… (a 0 after +592 is never a
// subscriber number — the shared worker would text a live one once real SMS is
// on). Each refusal happens before the first write.
//
// The pure gates are imported by path (scripts/ sits outside this package's
// rootDir, so a computed specifier keeps tsc out of it); the entrypoint is
// run as a child process against a fake local API that records every request.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const GUARD = join(ROOT, 'scripts/livetest/guard.ts');
const RUNNER = join(ROOT, 'scripts/livetest/run.ts');
const TSX = join(process.cwd(), 'node_modules/.bin/tsx');

let guard: any;
beforeAll(async () => {
  guard = await import(pathToFileURL(GUARD).href);
});

const refusedGate = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e: any) {
    if (e?.name === 'TargetRefused') return e.gate as string;
    throw e;
  }
  return null;
};

describe('[TASK-057] gate (p): no phone the suite uses can reach a real person', () => {
  it('accepts only never-a-subscriber +5920 numbers (and the Ofcom drama number it names for the non-Guyana refusal)', async () => {
    expect(() => guard.refuseLivePhones(['+5920400000', '+5920401001', '+5920499998'])).not.toThrow();
    for (const live of ['+5926000001', '+5926001000', '+592600999', '+5927001234', '+15550000000', '+447700900123']) {
      expect(await refusedGate(() => guard.refuseLivePhones(['+5920400000', live])), live).toBe('p');
    }
    expect(() => guard.refuseLivePhones(['+447700900123'], ['+447700900123'])).not.toThrow();
    expect(await refusedGate(() => guard.refuseLivePhones(['+447911123456'], ['+447911123456']))).toBe('p');
  });

  it('every fixed phone in the roster and every generated signup phone is +5920', async () => {
    const roster = await import(pathToFileURL(join(ROOT, 'scripts/livetest/roster.ts')).href);
    const common = await import(pathToFileURL(join(ROOT, 'scripts/livetest/journeys/common.ts')).href);
    const phones: string[] = [...roster.fixturePhones(), ...Array.from({ length: 200 }, (_, i) => common.freshPhone('t', 's', i))];
    expect(phones.length).toBeGreaterThan(220);
    expect(phones.filter((p) => !guard.FICTIONAL_GY.test(p))).toEqual([]);
    expect(phones).not.toContain('+5920400000'); // reserved for the staging seed admin
    expect(phones).not.toContain('+5920499999'); // reserved for journeys-run.sh's public-route probe
  });

  it('no phone literal in the runner or its deploy files leaves +5920 (the Ofcom drama prefix is the one exception)', () => {
    // The runtime gate covers the roster and the generators; this covers a literal typed into a
    // journey, a comment or a script — the former +592600 numbers were a live Digicel range.
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const files = [
      ...walk(join(ROOT, 'scripts/livetest')).filter((f) => /\.(ts|md)$/.test(f)),
      join(ROOT, 'deploy/journeys-run.sh'),
      join(ROOT, 'deploy/docker-compose.journeys.yml'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      for (const [literal] of readFileSync(file, 'utf8').matchAll(/\+\d{7,15}/g)) {
        if (!guard.FICTIONAL_GY.test(literal) && !/^\+447700900(\d{3})?$/.test(literal)) offenders.push(`${relative(ROOT, file)}: ${literal}`);
      }
    }
    expect(files.length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

describe('[TASK-057] gate (a): a private target only, judged by name before any lookup', () => {
  it('refuses the public staging hostname and every Swift public domain', async () => {
    for (const url of ['https://api-staging.swiftgy.com', 'https://API-STAGING.swiftgy.com.', 'https://api.swift.gy/x', 'http://swiftgy.com']) {
      expect(await refusedGate(() => guard.refusePublicName(url, {})), url).toBe('a');
    }
  });

  it('refuses the configured public host even when it is a bare name', async () => {
    expect(await refusedGate(() => guard.refusePublicName('http://edge:3000', { LIVETEST_PUBLIC_HOST: 'edge' }))).toBe('a');
  });

  it('refuses dotted DNS names, public addresses and non-HTTP schemes', async () => {
    for (const url of ['http://api.example.invalid:3000', 'http://203.0.113.7:3000', 'http://[2001:db8::1]:3000', 'ftp://127.0.0.1', 'not a url', 'http://0.0.0.0:3000']) {
      expect(await refusedGate(() => guard.refusePublicName(url, {})), url).toBe('a');
    }
  });

  it('accepts loopback and RFC 1918 literals without a lookup, and returns a service name for resolution', () => {
    for (const url of ['http://127.0.0.1:3291', 'http://[::1]:3000', 'http://10.1.2.3:3000', 'http://172.20.0.4:3000', 'http://192.168.1.9:3000']) {
      expect(guard.refusePublicName(url, {}), url).toBeNull();
    }
    expect(guard.refusePublicName('http://api-journeys:3000', {})).toBe('api-journeys');
    expect(guard.refusePublicName('http://localhost:3291', {})).toBe('localhost');
  });

  it('a service name must resolve only to private addresses', async () => {
    const via = (addrs: string[]) => async () => addrs;
    await expect(guard.refusePublicTarget('http://api-journeys:3000', {}, via(['172.18.0.5']))).resolves.toBeUndefined();
    expect(await refusedGate(guard.refusePublicTarget('http://api-journeys:3000', {}, via(['172.18.0.5', '93.184.216.34'])))).toBe('a');
    expect(await refusedGate(guard.refusePublicTarget('http://api-journeys:3000', {}, via([])))).toBe('a');
    expect(await refusedGate(guard.refusePublicTarget('http://api-journeys:3000', {}, async () => { throw new Error('ENOTFOUND'); }))).toBe('a');
  });
});

describe('[TASK-057] gates (b) and (c): identity and classification', () => {
  const identity = { deploymentId: 'dep-1', environment: 'staging', dataClassification: 'synthetic', buildSha: 'abc', testTenant: 'swift-default' };
  const http = (probe: number, auth: { status: number; data?: unknown }) => ({
    get: async (_p: string, token?: string) => (token ? { status: auth.status, json: { data: auth.data } } : { status: probe, json: null }),
  });

  it('a 404 probe refuses without signing anyone in', async () => {
    let signedIn = false;
    const gate = await refusedGate(guard.refuseUnsafeIdentity(http(404, { status: 200, data: identity }), async () => { signedIn = true; return 't'; }, {}));
    expect(gate).toBe('b');
    expect(signedIn).toBe(false);
  });

  it('refuses an unexpected probe answer, a failed sign-in and an unauthenticated identity read', async () => {
    expect(await refusedGate(guard.refuseUnsafeIdentity(http(200, { status: 200, data: identity }), async () => 't', {}))).toBe('b');
    expect(await refusedGate(guard.refuseUnsafeIdentity(http(401, { status: 200, data: identity }), async () => { throw new Error('INVALID_OTP'); }, {}))).toBe('b');
    expect(await refusedGate(guard.refuseUnsafeIdentity(http(401, { status: 403 }), async () => 't', {}))).toBe('b');
  });

  it('refuses production, an undeclared identity and a pinned mismatch', async () => {
    for (const environment of ['production', 'PRODUCTION', 'unknown', '']) {
      expect(await refusedGate(guard.refuseUnsafeIdentity(http(401, { status: 200, data: { ...identity, environment } }), async () => 't', {})), environment).toBe('b');
    }
    expect(await refusedGate(guard.refuseUnsafeIdentity(http(401, { status: 200, data: identity }), async () => 't', { LIVETEST_EXPECT_DEPLOYMENT_ID: 'dep-2' }))).toBe('b');
    expect(await refusedGate(guard.refuseUnsafeIdentity(http(401, { status: 200, data: identity }), async () => 't', { LIVETEST_EXPECT_BUILD_SHA: 'def' }))).toBe('b');
  });

  it('refuses any classification but synthetic, and accepts the intended target', async () => {
    for (const dataClassification of ['real', 'production', '', undefined]) {
      expect(await refusedGate(guard.refuseUnsafeIdentity(http(401, { status: 200, data: { ...identity, dataClassification } }), async () => 't', {}))).toBe('c');
    }
    const ok = await guard.refuseUnsafeIdentity(http(401, { status: 200, data: identity }), async () => 't', { LIVETEST_EXPECT_ENVIRONMENT: 'staging' });
    expect(ok).toMatchObject({ deploymentId: 'dep-1', environment: 'staging', dataClassification: 'synthetic' });
  });
});

// ── The real entrypoint, against a fake API that records every request ─────
type Seen = { method: string; url: string; auth: boolean };
let server: Server;
let port = 0;
let identityData: Record<string, unknown> = {};
let mode: 'absent' | 'present' = 'absent';
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: !!req.headers.authorization });
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    req.resume();
    req.on('end', () => {
      if (mode === 'absent') return send(404, { success: false, error: { code: 'NOT_FOUND' } });
      if (req.url === '/api/v1/test-control/identity') {
        if (!req.headers.authorization) return send(401, { success: false, error: { code: 'UNAUTHORIZED' } });
        return send(200, { success: true, data: identityData });
      }
      if (req.url === '/api/v1/auth/verify-otp' && req.method === 'POST') {
        return send(200, { success: true, data: { isNewUser: false, user: { id: 'admin-1' }, tokens: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresIn: 900 } } });
      }
      return send(500, { success: false, error: { code: 'UNEXPECTED_REQUEST' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runSuite(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const outDir = mkdtempSync(join(tmpdir(), 'journeys-guard-'));
  return new Promise((resolve) => {
    const child = spawn(TSX, [RUNNER, '--suite=journeys'], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'] ?? '', LIVETEST_OUT_DIR: outDir, LIVETEST_ADMIN_PHONE: '+5920400000', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (code) => { clearTimeout(timer); rmSync(outDir, { recursive: true, force: true }); resolve({ code, out }); });
  });
}

describe.skipIf(!existsSync(TSX))('[TASK-057] the runner entrypoint refuses before its first write', () => {
  it('a public DNS name: refused by name, no request made', async () => {
    seen.length = 0;
    const r = await runSuite({ LIVETEST_BASE_URL: 'http://api.public.invalid:3000' });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('REFUSED (a)');
  }, 70_000);

  it('the configured public hostname: refused by name', async () => {
    const r = await runSuite({ LIVETEST_BASE_URL: `http://localhost:${port}`, LIVETEST_PUBLIC_HOST: 'localhost' });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('REFUSED (a)');
  }, 70_000);

  it('no test-control route (production, or the public api): refused after ONE unauthenticated read', async () => {
    mode = 'absent';
    seen.length = 0;
    const r = await runSuite({ LIVETEST_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('REFUSED (b)');
    expect(seen).toEqual([{ method: 'GET', url: '/api/v1/test-control/identity', auth: false }]);
  }, 70_000);

  it('a production identity: refused after the sign-in and one identity read, nothing else', async () => {
    mode = 'present';
    identityData = { deploymentId: 'd', environment: 'production', dataClassification: 'synthetic', buildSha: 'x', testTenant: 't' };
    seen.length = 0;
    const r = await runSuite({ LIVETEST_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('REFUSED (b)');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/v1/test-control/identity',
      'POST /api/v1/auth/verify-otp',
      'GET /api/v1/test-control/identity',
    ]);
  }, 70_000);

  it('a non-synthetic classification: refused the same way', async () => {
    mode = 'present';
    identityData = { deploymentId: 'd', environment: 'staging', dataClassification: 'real', buildSha: 'x', testTenant: 't' };
    seen.length = 0;
    const r = await runSuite({ LIVETEST_BASE_URL: `http://127.0.0.1:${port}` });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('REFUSED (c)');
    expect(seen.filter((s) => s.method !== 'GET' && s.url !== '/api/v1/auth/verify-otp')).toEqual([]);
  }, 70_000);

  it('a live (subscriber-range) admin phone is refused before any request', async () => {
    seen.length = 0;
    const r = await runSuite({ LIVETEST_BASE_URL: `http://127.0.0.1:${port}`, LIVETEST_ADMIN_PHONE: '+5926001000' });
    expect(r.code, r.out).toBe(3);
    expect(r.out).toContain('REFUSED (p)');
    expect(seen).toEqual([]);
  }, 70_000);

  it('the admin phone is required before any request', async () => {
    seen.length = 0;
    const r = await runSuite({ LIVETEST_BASE_URL: `http://127.0.0.1:${port}`, LIVETEST_ADMIN_PHONE: '' });
    expect(r.code, r.out).toBe(3);
    expect(seen).toEqual([]);
  }, 70_000);
});
