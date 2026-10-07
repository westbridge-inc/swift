import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

// [W2] The size gate CI runs after `next build` (scripts/perf-budget.mjs).
const SCRIPT = join(__dirname, '..', 'scripts', 'perf-budget.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A fake build: random bytes do not compress, so each chunk's gzip size is about its length. */
function build(chunks: Record<string, number>, pages: Record<string, string[]>, ceilings: Record<string, number>) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-budget-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'static', 'chunks'), { recursive: true });
  for (const [name, bytes] of Object.entries(chunks)) writeFileSync(join(dir, 'static', 'chunks', name), randomBytes(bytes));
  writeFileSync(join(dir, 'app-build-manifest.json'), JSON.stringify({ pages: Object.fromEntries(Object.entries(pages).map(([page, files]) => [page, files.map((file) => `static/chunks/${file}`)])) }));
  writeFileSync(join(dir, 'budget.json'), JSON.stringify({ targetKb: 120, firstLoadJsKb: ceilings }));
  return dir;
}

function run(dir: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--next', dir, '--budget', join(dir, 'budget.json')], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, out: failure.stdout + failure.stderr };
  }
}

describe('[W2] the first-load size gate', () => {
  const chunks = { 'framework.js': 60_000, 'shell.js': 20_000, 'home.js': 10_000, 'styles.css': 50_000 };
  const pages = {
    '/layout': ['framework.js'],
    '/(app)/layout': ['framework.js', 'shell.js', 'styles.css'],
    '/(app)/page': ['framework.js', 'home.js'],
  };

  it('counts what a phone really downloads: the page AND every layout above it, scripts only, gzip', () => {
    // framework + shell + home ≈ 90 kB; the stylesheet is not script; the page entry alone would be ≈ 70 kB.
    const dir = build(chunks, pages, { '/(app)/page': 89 });
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/OVER\s+\/\(app\)\/page\s+9\d(\.\d)? kB/);
  });

  it('passes a page at or under its ceiling', () => {
    const dir = build(chunks, pages, { '/(app)/page': 95 });
    const result = run(dir);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/ok\s+\/\(app\)\/page/);
  });

  it('fails loudly when a budgeted page is missing from the build, rather than passing it unmeasured', () => {
    const dir = build(chunks, pages, { '/(app)/gone/page': 95 });
    const result = run(dir);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/not in this build/);
  });
});
