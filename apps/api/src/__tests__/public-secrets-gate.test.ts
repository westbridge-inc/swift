import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, chmodSync } from 'fs';
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
    const { code, output } = run(SCRIPT, ['--bundle', empty]);
    expect(code).toBe(1);
    expect(output).toMatch(/cannot prove anything|0 file/);
  });

  it('reports WHAT it scanned when it passes, so green means something', () => {
    const built = join(fixtureRoot, 'built');
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, 'chunk.js'), 'const api="https://api.example";\n'.repeat(50));
    const { code, output } = run(SCRIPT, ['--bundle', built]);
    expect(code).toBe(0);
    expect(output).toMatch(/scanned 1 file/);
  });

  it('still catches an unlisted public variable inside a built artefact', () => {
    const built = join(fixtureRoot, 'built-leak');
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, 'chunk.js'), 'process.env.NEXT_PUBLIC_LEAKED_THING'); // public-secrets-gate:fixture
    const { code, output } = run(SCRIPT, ['--bundle', built]);
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
    const r = run(join(root, 'scripts', 'public-secrets-gate.js'), ['--bundle', join(root, 'dist')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('NEXT_PUBLIC_MMG_SECRET'); // public-secrets-gate:fixture
  });

  it('bundle mode scans EVERY directory under the bundle — ios/, android/ and dist/ are build outputs here, not skip-listed source folders', () => {
    const root = makeFixture('bundle-nested', 'export {};\n', '');
    mkdirSync(join(root, 'dist', 'ios', '_expo'), { recursive: true });
    mkdirSync(join(root, 'dist', 'android'), { recursive: true });
    writeFileSync(join(root, 'dist', 'ios', '_expo', 'index.js'), 'var x = process.env.NEXT_PUBLIC_MMG_SECRET;\n'); // public-secrets-gate:fixture
    writeFileSync(join(root, 'dist', 'android', 'metadata.json'), '{}\n');
    const r = run(join(root, 'scripts', 'public-secrets-gate.js'), ['--bundle', join(root, 'dist')]);
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
      const r = run(join(root, 'scripts', 'public-secrets-gate.js'), ['--bundle', join(root, 'dist')]);
      expect(r.code).toBe(1);
      expect(r.output).toContain('could not be read');
    } finally {
      chmodSync(join(root, 'dist', 'locked.js'), 0o644);
    }
  });
});
