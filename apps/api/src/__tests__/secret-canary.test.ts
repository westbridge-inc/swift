import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// [TA-S0-006] The artifact secret canary (scripts/secret-canary.js).
//
// The name gate proves a public-prefixed identifier is justified; it cannot
// prove a built client carries no server secret, because bundlers inline the
// VALUE and drop the name, and CI builds with no secrets at all. The canary
// arms every server-only secret name with a marker value before a build and
// fails if the marker reaches what clients receive. These tests drive the
// real script against fixture trees and assert exit codes and messages —
// the failure mode of a scanner is silence, so every refusal is pinned.
// ---------------------------------------------------------------------------

const SCRIPT = join(__dirname, '..', '..', '..', '..', 'scripts', 'secret-canary.js');
const CANARY = /^SWIFT_CANARY_[A-Z0-9_]+_[0-9a-f]{12}$/;

let fixtureRoot: string;
let repoFixture: string;

function run(args: string[], env: Record<string, string> = {}): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A minimal environment: whatever this shell happens to carry must
      // neither arm nor disarm the canaries under test.
      env: { PATH: process.env['PATH'] ?? '', ...env },
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The armed environment the workflow would build with: parsed from --emit. */
function armed(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of run(['--root', root, '--emit']).output.trim().split('\n')) {
    const i = line.indexOf('=');
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function makeDist(name: string, files: Record<string, string | Buffer>): string {
  const dir = join(fixtureRoot, 'dist', name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'swift-secret-canary-'));
  // A repo-shaped tree: the API reads five names, one is a test file, the
  // deploy template names two more.
  repoFixture = join(fixtureRoot, 'repo');
  mkdirSync(join(repoFixture, 'apps', 'api', 'src', 'utils'), { recursive: true });
  mkdirSync(join(repoFixture, 'deploy'), { recursive: true });
  writeFileSync(
    join(repoFixture, 'apps', 'api', 'src', 'utils', 'config.ts'),
    [
      "const a = process.env['JWT_SECRET'];",
      'const b = process.env.MASTER_KEK;',
      "const c = process.env['LOG_LEVEL'];", // not secret-shaped
      "const d = process.env['NEXT_PUBLIC_API_URL'];", // the name gate's business
      "const e = process.env['ANDROID_GOOGLE_MAPS_API_KEY'];", // embedded by design
      '',
    ].join('\n'),
  );
  writeFileSync(join(repoFixture, 'apps', 'api', 'src', 'utils', 'config.test.ts'), "process.env['TEST_ONLY_TOKEN'];\n");
  writeFileSync(join(repoFixture, 'deploy', '.env.deploy.example'), 'POSTGRES_PASSWORD=change-me\nAPI_PORT=3000\n');
});
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('the census is generated from the tree, never maintained by hand', () => {
  it('--names lists every secret-shaped server-only name the API reads or the deploy template declares — and nothing else', () => {
    const r = run(['--root', repoFixture, '--names']);
    expect(r.code).toBe(0);
    expect(r.output.trim().split('\n')).toEqual(['JWT_SECRET', 'MASTER_KEK', 'POSTGRES_PASSWORD']);
  });

  it('--emit arms each name with a well-formed canary sharing one nonce', () => {
    const env = armed(repoFixture);
    expect(Object.keys(env).sort()).toEqual(['JWT_SECRET', 'MASTER_KEK', 'POSTGRES_PASSWORD']);
    for (const [name, value] of Object.entries(env)) {
      expect(value).toMatch(CANARY);
      expect(value.startsWith(`SWIFT_CANARY_${name}_`)).toBe(true);
    }
    const nonces = new Set(Object.values(env).map((v) => v.slice(-12)));
    expect(nonces.size).toBe(1);
  });

  it('an empty census refuses to arm — a canary set of zero certifies nothing', () => {
    const empty = join(fixtureRoot, 'empty-repo');
    mkdirSync(join(empty, 'apps', 'api', 'src'), { recursive: true });
    writeFileSync(join(empty, 'apps', 'api', 'src', 'x.ts'), "process.env['LOG_LEVEL'];\n");
    expect(run(['--root', empty, '--emit']).code).toBe(1);
    expect(run(['--root', empty, '--names']).code).toBe(1);
  });

  it('the REAL repository census is broad, carries the keys that matter, and excludes what it must', () => {
    const r = run(['--names']);
    expect(r.code).toBe(0);
    const names = r.output.trim().split('\n');
    expect(names.length).toBeGreaterThanOrEqual(20);
    for (const must of ['JWT_SECRET', 'MASTER_KEK', 'POSTGRES_PASSWORD', 'MMG_MSECRET', 'TWILIO_AUTH_TOKEN']) expect(names).toContain(must);
    expect(names).not.toContain('ANDROID_GOOGLE_MAPS_API_KEY'); // client-embedded by design, with its reason in the script
    expect(names.filter((n) => /^(EXPO_PUBLIC|NEXT_PUBLIC|VITE)_/.test(n))).toEqual([]);
  });
});

describe('--scan refuses what it exists to refuse', () => {
  it('refuses to pass when the canaries are not armed — a forgotten --emit cannot go green', () => {
    const dist = makeDist('clean-unarmed', { 'app.js': 'console.log("hello")\n' });
    const r = run(['--root', repoFixture, '--scan', dist]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('not armed');
  });

  it('refuses when only SOME canaries are armed', () => {
    const env = armed(repoFixture);
    delete env['MASTER_KEK'];
    const dist = makeDist('clean-partial', { 'app.js': 'console.log("hello")\n' });
    const r = run(['--root', repoFixture, '--scan', dist], env);
    expect(r.code).toBe(1);
    expect(r.output).toContain('MASTER_KEK');
  });

  it('fails on a canary inlined into a text artifact, naming the variable and the file', () => {
    const env = armed(repoFixture);
    const dist = makeDist('leak-text', { 'static/chunks/main.js': `var k="${env['JWT_SECRET']}";\n`, 'ok.js': 'x\n' });
    const r = run(['--root', repoFixture, '--scan', dist], env);
    expect(r.code).toBe(1);
    expect(r.output).toContain('JWT_SECRET');
    expect(r.output).toContain('main.js');
    expect(r.output).not.toContain('MASTER_KEK');
  });

  it('fails on a canary buried in a BINARY artifact — the scan is byte-level, not line-level', () => {
    const env = armed(repoFixture);
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), Buffer.from(env['POSTGRES_PASSWORD'] as string, 'latin1'), Buffer.from([0xff, 0xfe, 0])]);
    const dist = makeDist('leak-binary', { 'assets/logo.png': bytes });
    const r = run(['--root', repoFixture, '--scan', dist], env);
    expect(r.code).toBe(1);
    expect(r.output).toContain('POSTGRES_PASSWORD');
    expect(r.output).toContain('logo.png');
  });

  it('fails on a missing directory and on an empty one — a gate that scanned nothing is not a gate', () => {
    const env = armed(repoFixture);
    const missing = run(['--root', repoFixture, '--scan', join(fixtureRoot, 'dist', 'nope')], env);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain('does not exist');
    const empty = makeDist('empty', {});
    const r = run(['--root', repoFixture, '--scan', empty], env);
    expect(r.code).toBe(1);
    expect(r.output).toContain('is empty');
  });

  it('fails when a file could not be read — a partial scan is not a scan', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads everything; nothing to prove here
    const env = armed(repoFixture);
    const dist = makeDist('unreadable', { 'app.js': 'x\n', 'locked.js': 'y\n' });
    chmodSync(join(dist, 'locked.js'), 0o000);
    try {
      const r = run(['--root', repoFixture, '--scan', dist], env);
      expect(r.code).toBe(1);
      expect(r.output).toContain('could not be read');
    } finally {
      chmodSync(join(dist, 'locked.js'), 0o644);
    }
  });
});

describe('--scan passes what it should pass', () => {
  it('a clean artifact tree under a fully armed environment passes and says what it certified', () => {
    const env = armed(repoFixture);
    const dist = makeDist('clean', { 'static/chunks/main.js': 'var api="https://api.example";\n', 'assets/a.bin': Buffer.from([0, 1, 2, 3]) });
    const r = run(['--root', repoFixture, '--scan', dist], env);
    expect(r.code).toBe(0);
    expect(r.output).toContain('3 server-only secret(s) armed');
    expect(r.output).toContain('2 file(s)');
  });
});
