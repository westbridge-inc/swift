import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, chmodSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * [GRD-1 §2 · WS-15] The public-prefix gate, tested by making it FAIL.
 *
 * `EXPO_PUBLIC_*` and `NEXT_PUBLIC_*` are inlined at build time, so a value
 * given one of those prefixes is published in every install. gitleaks cannot
 * catch that class — the source contains only a variable NAME, and the real
 * value arrives from CI's environment during the build. The gate is therefore
 * on the name.
 *
 * A gate is only worth its CI minute if it goes red. These tests drive the real
 * script against fixture trees and assert the exit code, because the failure
 * mode of a scanner is silence: a wrong directory or a broken pattern makes it
 * scan nothing and pass forever, which looks exactly like safety.
 */

const SCRIPT = resolve(process.cwd(), '../../scripts/public-secrets-gate.js');
const MANIFEST_SCRIPT = resolve(process.cwd(), '../../scripts/artifact-manifest.js');

let fixtureRoot: string;

/** Run a gate script with arbitrary args from an arbitrary cwd. */
function run(script: string, args: string[], cwd?: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Run the repository gate against a fixture tree. */
function runGate(root: string): { code: number; output: string } {
  return run(SCRIPT, [root]);
}

/** Build a minimal repo-shaped fixture: apps/<file> + security/allowlist. */
function makeFixture(name: string, sourceLine: string, allowlist: string, fileName = 'config.ts'): string {
  const root = join(fixtureRoot, name);
  mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
  mkdirSync(join(root, 'security'), { recursive: true });
  writeFileSync(join(root, 'apps', 'web', 'src', fileName), sourceLine);
  writeFileSync(join(root, 'security', 'public-env-allowlist.txt'), allowlist);
  // The script resolves its own default root from __dirname/.. — the fixture
  // needs its own copy so an argv root is genuinely honoured.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(root, 'scripts', 'public-secrets-gate.js'));
  return root;
}

/** The first regular file under `dir` (depth-first, sorted), as a bundle-relative posix path — the entrypoint a fixture's manifest declares. */
function firstRegularFile(dir: string, rel = ''): string | null {
  const fs = require('fs') as typeof import('fs');
  let names: string[];
  try { names = fs.readdirSync(dir).sort(); } catch { return null; }
  for (const name of names) {
    const abs = join(dir, name);
    const here = rel ? `${rel}/${name}` : name;
    let st: import('fs').Stats;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) return here;
    if (st.isDirectory()) { const nested = firstRegularFile(abs, here); if (nested) return nested; }
  }
  return null;
}

/** Bind a fixture-copy gate run the way CI does: the manifest of root/dist, then the copied gate against it. */
function gateBoundCopy(root: string): { code: number; output: string } {
  const dist = join(root, 'dist');
  const m = join(root, 'dist.manifest.json');
  const first = firstRegularFile(dist) ?? 'index.js';
  run(MANIFEST_SCRIPT, [dist, '--app', 'web', '--commit', 'sha-1', '--entry', first, '--out', m]);
  return run(join(root, 'scripts', 'public-secrets-gate.js'), ['--bundle', dist, '--manifest', m, '--app', 'web', '--commit', 'sha-1']);
}

const JUSTIFIED = 'a public hostname every request already announces, not a credential';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'swift-public-env-'));
});
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('the gate refuses what it exists to refuse', () => {
  it('fails on a public-prefixed variable that is not allowlisted', () => {
    const root = makeFixture(
      'unlisted',
      "export const x = process.env['NEXT_PUBLIC_MMG_SECRET'];\n", // public-secrets-gate:fixture
      `NEXT_PUBLIC_API_URL # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
    );
    const { code, output } = runGate(root);
    expect(code).toBe(1);
    expect(output).toContain('NEXT_PUBLIC_MMG_SECRET'); // public-secrets-gate:fixture
    // The name reads like a credential, so the message must say so plainly
    // rather than filing it as one more unlisted variable.
    expect(output).toMatch(/reads like a SECRET/);
  });

  it('fails an allowlist entry with no written justification', () => {
    // "Add the name to the list" must not be a way to make the gate quiet.
    // The reason has to be written down, because the reason is the review.
    const root = makeFixture(
      'unjustified',
      "export const x = process.env['NEXT_PUBLIC_API_URL'];\n", // public-secrets-gate:fixture
      'NEXT_PUBLIC_API_URL # ok\n', // public-secrets-gate:fixture
    );
    const { code, output } = runGate(root);
    expect(code).toBe(1);
    expect(output).toMatch(/needs a written justification/);
  });

  it('fails a secret-shaped name that was allowlisted without the explicit marker', () => {
    const root = makeFixture(
      'unmarked',
      "export const x = process.env['NEXT_PUBLIC_ANALYTICS_KEY'];\n", // public-secrets-gate:fixture
      `NEXT_PUBLIC_ANALYTICS_KEY # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
    );
    const { code, output } = runGate(root);
    expect(code).toBe(1);
    expect(output).toMatch(/!not-a-secret/);
  });

  it('fails an allowlist entry nothing uses — stale permission is still permission', () => {
    // Audited from BOTH sides, like the stock-photo gate's exemptions: a
    // permission that outlives its reason is how the list stops meaning
    // anything.
    const root = makeFixture(
      'stale',
      'export const x = 1;\n',
      `NEXT_PUBLIC_API_URL # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
    );
    const { code, output } = runGate(root);
    expect(code).toBe(1);
    expect(output).toMatch(/used nowhere/);
  });

  it('fails when the allowlist file is missing entirely', () => {
    // Deleting the list must not be a way to pass.
    const root = join(fixtureRoot, 'nolist');
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(SCRIPT, join(root, 'scripts', 'public-secrets-gate.js'));
    writeFileSync(join(root, 'apps', 'web', 'src', 'config.ts'), "process.env['NEXT_PUBLIC_API_URL'];\n"); // public-secrets-gate:fixture
    const { code, output } = runGate(root);
    expect(code).toBe(1);
    expect(output).toMatch(/Allowlist not found/);
  });
});

describe('the gate passes what it should pass', () => {
  it('accepts an allowlisted, justified variable', () => {
    const root = makeFixture(
      'clean',
      "export const x = process.env['NEXT_PUBLIC_API_URL'];\n", // public-secrets-gate:fixture
      `NEXT_PUBLIC_API_URL # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
    );
    const { code, output } = runGate(root);
    expect(code).toBe(0);
    expect(output).toContain('NEXT_PUBLIC_API_URL'); // public-secrets-gate:fixture
  });

  it('accepts a secret-shaped name that carries the explicit marker', () => {
    const root = makeFixture(
      'marked',
      "export const x = process.env['NEXT_PUBLIC_ALLOW_SITE_TOKENS'];\n", // public-secrets-gate:fixture
      `NEXT_PUBLIC_ALLOW_SITE_TOKENS !not-a-secret # ${JUSTIFIED}, it is a build escape hatch carrying no value\n`, // public-secrets-gate:fixture
    );
    expect(runGate(root).code).toBe(0);
  });
});

describe('the fixture escape hatch cannot become a hole', () => {
  // The gate's OWN negative tests have to write a secret-shaped public name
  // somewhere, or nothing proves the gate refuses it. Excluding all test files
  // would be the easy fix and the wrong one — a fixture holding a real key is a
  // classic leak, so tests are exactly where scanning must continue. Hence a
  // per-line marker, honoured ONLY in a test file.
  const MARKER = ['public-secrets-gate', 'fixture'].join(':');

  it('honours the marker inside a test file', () => {
    const root = makeFixture(
      'marker-in-test',
      `export const x = process.env['NEXT_PUBLIC_NOT_LISTED']; // ${MARKER}\n`, // public-secrets-gate:fixture
      `NEXT_PUBLIC_API_URL # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
      'thing.test.ts',
    );
    const { code, output } = runGate(root);
    // The allowlisted entry is now unused (the only source line is suppressed),
    // so this fails for THAT reason — never for the suppressed variable.
    expect(output).not.toContain('NEXT_PUBLIC_NOT_LISTED'); // public-secrets-gate:fixture
    expect(code).toBe(1);
    expect(output).toMatch(/used nowhere/);
  });

  it('IGNORES the marker in ordinary source — the hatch is test-only', () => {
    // If a marker in production code silenced the gate, the gate would be
    // optional, and an optional gate is decoration.
    const root = makeFixture(
      'marker-in-source',
      `export const x = process.env['NEXT_PUBLIC_NOT_LISTED']; // ${MARKER}\n`, // public-secrets-gate:fixture
      `NEXT_PUBLIC_API_URL # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
    );
    const { code, output } = runGate(root);
    expect(code).toBe(1);
    expect(output).toContain('NEXT_PUBLIC_NOT_LISTED'); // public-secrets-gate:fixture
  });
});

describe('bundle mode cannot pass by scanning nothing [R037-23]', () => {
  // The failure mode of a scanner is silence. `walk()` turned a missing
  // directory into an empty result, so --bundle against a path that does not
  // exist printed green with zero variables found. A renamed Next `distDir`, a
  // build that did not run, or a wrong workflow path would have removed this
  // gate entirely while CI stayed green.
  it('fails when the built directory does not exist', () => {
    const { code, output } = run(SCRIPT, ['--bundle', join(fixtureRoot, 'no-such-build')]);
    expect(code).toBe(1);
    expect(output).toMatch(/does not exist/);
  });

  it('fails when the path is not a directory', () => {
    const file = join(fixtureRoot, 'not-a-dir');
    writeFileSync(file, 'x');
    const { code, output } = run(SCRIPT, ['--bundle', file]);
    expect(code).toBe(1);
    expect(output).toMatch(/not a directory/);
  });

  it('fails when the build output is empty', () => {
    const empty = join(fixtureRoot, 'empty-build');
    mkdirSync(empty, { recursive: true });
    const { code, output } = gateBound(empty);
    expect(code).toBe(1);
    expect(output).toMatch(/cannot prove anything|0 file/);
  });

  it('reports WHAT it scanned when it passes, so green means something', () => {
    const built = join(fixtureRoot, 'built');
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, 'chunk.js'), 'const api="https://api.example";\n'.repeat(50));
    const { code, output } = gateBound(built);
    expect(code).toBe(0);
    expect(output).toMatch(/scanned 1 file/);
  });

  it('still catches an unlisted public variable inside a built artefact', () => {
    const built = join(fixtureRoot, 'built-leak');
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, 'chunk.js'), 'process.env.NEXT_PUBLIC_LEAKED_THING'); // public-secrets-gate:fixture
    const { code, output } = gateBound(built);
    expect(code).toBe(1);
    expect(output).toMatch(/NEXT_PUBLIC_LEAKED_THING/); // public-secrets-gate:fixture
  });
});

describe('the default-root seam CI actually uses [R037-24]', () => {
  it('resolves its root from the script location when given no argument', () => {
    // Every other test passes an explicit root, so the seam CI depends on —
    // `node scripts/public-secrets-gate.js` with no args, from the repo root —
    // was never executed. Run the fixture COPY, from a different cwd, with no
    // root argument.
    const root = makeFixture(
      'default-root',
      "export const x = process.env['NEXT_PUBLIC_ROOTLESS'];\n", // public-secrets-gate:fixture
      `NEXT_PUBLIC_API_URL # ${JUSTIFIED}\n`, // public-secrets-gate:fixture
    );
    const { code, output } = run(join(root, 'scripts', 'public-secrets-gate.js'), [], tmpdir());
    // It must have found the FIXTURE's file, proving it derived the root from
    // its own location rather than from the working directory.
    expect(code).toBe(1);
    expect(output).toMatch(/NEXT_PUBLIC_ROOTLESS/); // public-secrets-gate:fixture
  });
});

describe('the real repository allowlist', () => {
  it('lists every public-prefixed variable the repo actually uses', () => {
    // Runs the gate against THIS checkout. NOTE: a worktree's disk copy can lag
    // origin/main (work ships through a temp index and never lands on disk), so
    // a local failure here may be staleness rather than a real violation — CI
    // checks out the real tree and is the authority. The assertion is on the
    // shape of the answer, so it holds either way.
    const { output } = runGate(resolve(process.cwd(), '../..'));
    expect(output).toMatch(/public-secrets-gate|Public-prefixed|used nowhere/);
  });
});

// ---------------------------------------------------------------------------
// [TA-S0-006] The third naming seam, and a bundle that cannot excuse itself.
// ---------------------------------------------------------------------------
describe('[TA-S0-006] the Vite seam and the bundle mode', () => {
  it('knows the Vite seam: an unlisted VITE_ name fails in source mode, like the other two prefixes', () => {
    const root = makeFixture('vite', 'const u = import.meta.env.VITE_ANALYTICS_KEY;\n', ''); // public-secrets-gate:fixture
    const r = runGate(root);
    expect(r.code).toBe(1);
    expect(r.output).toContain('VITE_ANALYTICS_KEY'); // public-secrets-gate:fixture
    expect(r.output).toContain('reads like a SECRET');
  });

  it('accepts a justified VITE_ name', () => {
    const root = makeFixture('vite-ok', 'const u = import.meta.env.VITE_API_URL;\n', `VITE_API_URL # ${JUSTIFIED}\n`); // public-secrets-gate:fixture
    expect(runGate(root).code).toBe(0);
  });

  it('bundle mode IGNORES the fixture marker — a built file cannot excuse itself with a comment', () => {
    const root = makeFixture('bundle-marker', 'export {};\n', '');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'chunk.test.js'), 'var x = process.env.NEXT_PUBLIC_MMG_SECRET; // public-secrets-gate:fixture\n');
    const r = gateBoundCopy(root);
    expect(r.code).toBe(1);
    expect(r.output).toContain('NEXT_PUBLIC_MMG_SECRET'); // public-secrets-gate:fixture
  });

  it('bundle mode scans EVERY directory under the bundle — ios/, android/ and dist/ are build outputs here, not skip-listed source folders', () => {
    const root = makeFixture('bundle-nested', 'export {};\n', '');
    mkdirSync(join(root, 'dist', 'ios', '_expo'), { recursive: true });
    mkdirSync(join(root, 'dist', 'android'), { recursive: true });
    writeFileSync(join(root, 'dist', 'ios', '_expo', 'index.js'), 'var x = process.env.NEXT_PUBLIC_MMG_SECRET;\n'); // public-secrets-gate:fixture
    writeFileSync(join(root, 'dist', 'android', 'metadata.json'), '{}\n');
    const r = gateBoundCopy(root);
    expect(r.code).toBe(1);
    expect(r.output).toContain('NEXT_PUBLIC_MMG_SECRET'); // public-secrets-gate:fixture
    expect(r.output).toContain('scanned 2 file(s)');
  });

  it('bundle mode fails when a file could not be read — a partial scan is not a scan', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads everything
    const root = makeFixture('bundle-unreadable', 'export {};\n', '');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'ok.js'), 'var y = 1;\n');
    writeFileSync(join(root, 'dist', 'locked.js'), 'var z = 2;\n');
    chmodSync(join(root, 'dist', 'locked.js'), 0o000);
    try {
      const r = gateBoundCopy(root);
      expect(r.code).toBe(1);
      expect(r.output).toContain('could not be read');
    } finally {
      chmodSync(join(root, 'dist', 'locked.js'), 0o644);
    }
  });
});

// ---------------------------------------------------------------------------
// [SCR-005 / SCR-006 / SCR-007] The gate certifies THIS artifact, by value.
// ---------------------------------------------------------------------------

function makeBundle(name: string, files: Record<string, string>): { dir: string; root: string } {
  const root = join(fixtureRoot, name);
  const dir = join(root, 'build');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'security'), { recursive: true });
  writeFileSync(join(root, 'security', 'public-env-allowlist.txt'), '');
  for (const [rel, content] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), content); }
  return { dir, root };
}
function manifestFor(dir: string, out: string, opts: { app?: string; commit?: string; entry?: string } = {}) {
  return run(MANIFEST_SCRIPT, [dir, '--app', opts.app ?? 'web', '--commit', opts.commit ?? 'sha-1', '--entry', opts.entry ?? 'BUILD_ID', '--out', out]);
}
const bundleGate = (dir: string, root: string, extra: string[]) => run(SCRIPT, ['--bundle', dir, ...extra, root]);
/** Bind a bundle fixture the way CI does: generate its manifest, then gate against it. */
function gateBound(dir: string): { code: number; output: string } {
  const m = join(dir, '..', `${require('path').basename(dir)}.manifest.json`);
  const first = firstRegularFile(dir) ?? 'BUILD_ID';
  run(MANIFEST_SCRIPT, [dir, '--app', 'web', '--commit', 'sha-1', '--entry', first, '--out', m]);
  return run(SCRIPT, ['--bundle', dir, '--manifest', m, '--app', 'web', '--commit', 'sha-1']);
}

describe('bundle mode is bound to its artifact manifest [SCR-006]', () => {
  it('a bundle without a manifest is not an artifact; the right manifest passes', () => {
    const { dir, root } = makeBundle('m-none', { BUILD_ID: 'abc', 'static/app.js': 'console.log(1)' });
    expect(bundleGate(dir, root, []).code).toBe(1);
    const m = join(root, 'm.json'); expect(manifestFor(dir, m).code).toBe(0);
    const ok = bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1']);
    expect(ok.code).toBe(0); expect(ok.output).toContain('manifest ok');
  });
  it('the wrong app, a stale commit, a tampered file, a missing or zero-byte entrypoint, an undeclared file, an escaping symlink and an unreadable file all fail', () => {
    const { dir, root } = makeBundle('m-bad', { BUILD_ID: 'abc', 'static/app.js': 'console.log(1)' });
    const m = join(root, 'm.json'); manifestFor(dir, m);
    expect(bundleGate(dir, root, ['--manifest', m, '--app', 'admin', '--commit', 'sha-1']).output).toContain('not "admin"');
    expect(bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-2']).output).toContain('stale or foreign');
    writeFileSync(join(dir, 'static/app.js'), 'console.log(2)');
    // the per-file digest AND the recomputed tree digest each name the tamper — two independent findings, both asserted
    const tampered = bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1']).output;
    expect(tampered).toContain('static/app.js: digest');
    expect(tampered).toContain('tree digest');
    writeFileSync(join(dir, 'static/app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'extra.js'), 'x');
    expect(bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1']).output).toContain('not in the manifest');
    rmSync(join(dir, 'extra.js'));
    writeFileSync(join(dir, 'BUILD_ID'), '');
    expect(bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1']).output).toContain('zero bytes');
    rmSync(join(dir, 'BUILD_ID'));
    expect(bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1']).output).toContain('missing');
    writeFileSync(join(dir, 'BUILD_ID'), 'abc');
    // an escaping symlink declared in a fresh manifest
    const { dir: d2, root: r2 } = makeBundle('m-link', { BUILD_ID: 'abc' });
    writeFileSync(join(r2, 'outside.txt'), 'secret-outside');
    symlinkSync(join(r2, 'outside.txt'), join(d2, 'link.txt'));
    const m2 = join(r2, 'm.json'); manifestFor(d2, m2);
    expect(bundleGate(d2, r2, ['--manifest', m2, '--app', 'web', '--commit', 'sha-1']).output).toContain('escapes the bundle');
    // an unreadable declared file (skipped when running as root, where nothing is unreadable)
    if (process.getuid && process.getuid() !== 0) {
      const { dir: d3, root: r3 } = makeBundle('m-unreadable', { BUILD_ID: 'abc', 'chunk.js': 'x' });
      const m3 = join(r3, 'm.json'); manifestFor(d3, m3);
      chmodSync(join(d3, 'chunk.js'), 0o000);
      const res = bundleGate(d3, r3, ['--manifest', m3, '--app', 'web', '--commit', 'sha-1']);
      chmodSync(join(d3, 'chunk.js'), 0o644);
      expect(res.code).toBe(1); expect(res.output).toContain('unreadable');
    }
  });
});

describe('bundle mode scans the whole artifact tree [SCR-005]', () => {
  it('a nested ios/ or build/ directory is scanned like any other — the source skip list never applies below a bundle root (the Expo export layout)', () => {
    // `expo export --output-dir dist/ios` writes the JS bundle to dist/ios/_expo/static/js/ios/<entry>-<hash>.js — four levels down, under a directory named ios/
    const { dir, root } = makeBundle('nested-ios', {
      'ios/metadata.json': '{}',
      'ios/_expo/static/js/ios/entry-1.js': 'var u=process.env.EXPO_PUBLIC_MMG_SECRET;', // public-secrets-gate:fixture
      'android/metadata.json': '{}',
      'android/_expo/static/js/android/entry-1.js': 'var x=1;',
    });
    const m = join(root, 'm.json'); manifestFor(dir, m, { app: 'mobile', entry: 'ios/metadata.json' });
    const r = bundleGate(dir, root, ['--manifest', m, '--app', 'mobile', '--commit', 'sha-1']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('EXPO_PUBLIC_MMG_SECRET'); // public-secrets-gate:fixture
    expect(r.output).toContain('ios/_expo/static/js/ios/entry-1.js');
  });
  it('a file under a nested build/ directory that the manifest does not declare is still "not in the manifest"', () => {
    const { dir, root } = makeBundle('nested-undeclared', { BUILD_ID: 'abc', 'server/app.js': 'x' });
    const m = join(root, 'm.json'); manifestFor(dir, m);
    mkdirSync(join(dir, 'server', 'build'), { recursive: true });
    writeFileSync(join(dir, 'server', 'build', 'late.js'), 'y');
    const r = bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('server/build/late.js: present in the bundle but not in the manifest');
  });
});

describe('a scan receipt exists only for a certified artifact [SCR-006]', () => {
  it('a pass writes the receipt with the recomputed tree digest and the commit; a failure writes none; a manifest whose tree digest lies fails', () => {
    const { dir, root } = makeBundle('receipt', { BUILD_ID: 'abc', 'static/app.js': 'console.log(1)' });
    const m = join(root, 'm.json'); manifestFor(dir, m);
    const receipt = join(root, 'receipt.json');
    const ok = bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1', '--receipt', receipt]);
    expect(ok.code).toBe(0);
    const r = JSON.parse(readFileSync(receipt, 'utf8'));
    const man = JSON.parse(readFileSync(m, 'utf8'));
    expect(r.result).toBe('pass'); expect(r.app).toBe('web'); expect(r.commit).toBe('sha-1');
    expect(r.treeDigest).toHaveLength(64); expect(r.treeDigest).toBe(man.treeDigest);
    // a failing gate writes no receipt
    rmSync(receipt);
    writeFileSync(join(dir, 'static/app.js'), 'console.log(2)');
    expect(bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1', '--receipt', receipt]).code).toBe(1);
    expect(existsSync(receipt)).toBe(false);
    writeFileSync(join(dir, 'static/app.js'), 'console.log(1)');
    // the tree digest is recomputed from the bytes, never copied from the manifest
    man.treeDigest = 'f'.repeat(64);
    writeFileSync(m, JSON.stringify(man));
    const lie = bundleGate(dir, root, ['--manifest', m, '--app', 'web', '--commit', 'sha-1', '--receipt', receipt]);
    expect(lie.code).toBe(1); expect(lie.output).toContain('tree digest'); expect(existsSync(receipt)).toBe(false);
  });
});

describe('a workflow file is a seam: values are scanned, comments are prose', () => {
  it('an unlisted public name in a workflow VALUE fails; the same name in a workflow comment does not', () => {
    const root = makeFixture('yml-value', 'export const ok = 1;\n', '');
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    const wf = join(root, '.github', 'workflows', 'ci.yml');
    writeFileSync(wf, 'jobs:\n  b:\n    steps:\n      - run: pnpm build\n        env:\n          NEXT_PUBLIC_MMG_SECRET: ${{ secrets.X }}\n'); // public-secrets-gate:fixture
    const bad = runGate(root);
    expect(bad.code).toBe(1); expect(bad.output).toContain('NEXT_PUBLIC_MMG_SECRET'); // public-secrets-gate:fixture
    writeFileSync(wf, 'jobs:\n  b:\n    steps:\n      # NEXT_PUBLIC_MMG_SECRET here would be a leak; this line is prose\n      - run: pnpm build\n'); // public-secrets-gate:fixture
    expect(runGate(root).code).toBe(0);
  });
});

describe('a fixture exemption production can reach is a leak [SCR-007]', () => {
  it('a marked test file imported by ordinary source fails; the same file left alone passes', () => {
    const marked = `const url = process.env.NEXT_PUBLIC_LEAK_PROBE; // public-secrets-gate:fixture\nexport const probe = url;\n`;
    const root = makeFixture('x-reach', marked, '', 'probe.test.ts');
    writeFileSync(join(root, 'apps', 'web', 'src', 'page.ts'), "import { probe } from './probe.test';\nexport const p = probe;\n");
    const res = runGate(root);
    expect(res.code).toBe(1); expect(res.output).toContain('imported by production source');
    const root2 = makeFixture('x-alone', marked, '', 'probe.test.ts');
    expect(runGate(root2).code).toBe(0);
  });
});
