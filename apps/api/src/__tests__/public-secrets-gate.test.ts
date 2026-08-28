import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'fs';
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

/** Run the gate against a fixture tree; returns exit code + combined output. */
function runGate(root: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
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
