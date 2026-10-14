import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// [CI-SPLIT] The API suite runs as N shard jobs, and one aggregate job named
// "API Tests" is the check branch protection requires. Two things can quietly
// stop a test from gating a merge once the suite is split:
//   1. a file falls between the shards (or a shard never reports) — the
//      partition script (scripts/ci-api-shard-partition.mjs) must refuse it;
//   2. the aggregate stops reflecting the shards — skipped instead of failed,
//      or the shard list, the shard total and the partition --count drift.
// These tests drive the real script on fixtures and read the real workflow.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'ci-api-shard-partition.mjs');
const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');

/** The text of one job: from `  <id>:` to the next two-space-indented key. */
function jobBlock(id: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line === `  ${id}:`);
  expect(start, `job ${id} exists in ci.yml`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[a-z][\w-]*:\s*$/.test(lines[end] ?? '')) end += 1;
  return lines.slice(start, end).join('\n');
}

let root: string;

function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A suite root with these files, and shard i's JUnit report naming shards[i-1]. */
function fixture(files: string[], shards: Array<string[] | null>): string[] {
  const suite = join(root, 'apps', 'api');
  writeFileSync(join(root, 'expected.json'), JSON.stringify(files.map((f) => ({ file: join(suite, f) }))));
  mkdirSync(join(root, 'junit'), { recursive: true });
  shards.forEach((names, i) => {
    if (names === null) return;
    const suites = names.map((n) => `  <testsuite name="${n}" tests="1" failures="0" errors="0" skipped="0" time="0.1">\n  </testsuite>`).join('\n');
    writeFileSync(join(root, 'junit', `junit-${i + 1}.xml`), `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="${names.length}">\n${suites}\n</testsuites>\n`);
  });
  return ['--root', suite, '--expected', join(root, 'expected.json'), '--junit-dir', join(root, 'junit'), '--count', String(shards.length)];
}

const A = 'src/__tests__/a.test.ts';
const B = 'src/__tests__/b.test.ts';
const C = 'src/modules/x/c.test.ts';

describe('[CI-SPLIT] the shard partition proof', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-shards-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes when every file ran in exactly one shard', () => {
    const { code, output } = run(fixture([A, B, C], [[A, C], [B]]));
    expect(output).toContain('ok: 3 API test files, each ran in exactly one of 2 shards (2 + 1)');
    expect(code).toBe(0);
  });

  it('fails, naming the file, when a file ran in no shard', () => {
    const { code, output } = run(fixture([A, B, C], [[A], [B]]));
    expect(code).toBe(1);
    expect(output).toMatch(/1 test file\(s\) ran in NO shard/);
    expect(output).toContain(C);
  });

  it('fails when a file ran in two shards', () => {
    const { code, output } = run(fixture([A, B, C], [[A, B], [B, C]]));
    expect(code).toBe(1);
    expect(output).toContain(`${B} (shards 1, 2)`);
  });

  it('fails when a shard ran a file the suite does not list', () => {
    const { code, output } = run(fixture([A, B], [[A], [B, C]]));
    expect(code).toBe(1);
    expect(output).toMatch(/ran that the suite's file list does not contain/);
    expect(output).toContain(C);
  });

  it('fails when a shard left no report, even if the others cover every file', () => {
    const { code, output } = run(fixture([A, B], [[A, B], null]));
    expect(code).toBe(1);
    expect(output).toContain('shard 2 of 2 left no report');
  });

  it('fails when a report exists for a shard outside the configured count', () => {
    const args = fixture([A, B], [[A], [B]]);
    writeFileSync(join(root, 'junit', 'junit-3.xml'), '<testsuites></testsuites>\n');
    const { code, output } = run(args);
    expect(code).toBe(1);
    expect(output).toContain('junit-3.xml is not one of the 2 shards');
  });

  it('refuses to certify an empty suite (a partition of nothing is not proof)', () => {
    const { code, output } = run(fixture([], [[], []]));
    expect(code).toBe(1);
    expect(output).toMatch(/expected file list is empty/);
  });

  it('reads XML-escaped file names as the files they name', () => {
    const odd = 'src/__tests__/r&d.test.ts';
    const { code } = run(fixture([odd, A], [['src/__tests__/r&amp;d.test.ts'], [A]]));
    expect(code).toBe(0);
  });
});

describe('[CI-SPLIT] the workflow keeps one honest "API Tests" verdict', () => {
  const shardJob = jobBlock('api-test-shard');
  const aggregate = jobBlock('api-test');

  it('exactly one job carries the required check name "API Tests", and it is the aggregate', () => {
    expect(WORKFLOW.match(/^ {4}name: API Tests\s*$/gm)).toHaveLength(1);
    expect(aggregate).toMatch(/^ {4}name: API Tests\s*$/m);
  });

  it('the aggregate always reports, waits for every shard, and fails unless they all succeeded', () => {
    expect(aggregate).toMatch(/^ {4}needs: api-test-shard\s*$/m);
    // A skipped required check reads as passing to branch protection.
    expect(aggregate).toMatch(/^ {4}if: always\(\)\s*$/m);
    expect(aggregate).toContain('SHARDS_RESULT: ${{ needs.api-test-shard.result }}');
    expect(aggregate).toMatch(/if \[ "\$SHARDS_RESULT" != "success" \]; then[\s\S]*?exit 1/);
  });

  it('the shard list, the shard total and the partition --count agree', () => {
    const shards = shardJob.match(/^ {8}shard: \[([\d, ]+)\]\s*$/m)?.[1]?.split(',').map((s) => Number(s.trim()));
    const total = Number(shardJob.match(/^ {8}total: \[(\d+)\]\s*$/m)?.[1]);
    const count = Number(aggregate.match(/ci-api-shard-partition\.mjs .*--count (\d+)/)?.[1]);
    expect(total).toBeGreaterThan(1);
    expect(shards).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(count).toBe(total);
    expect(shardJob).toContain('--shard=${{ matrix.shard }}/${{ matrix.total }}');
  });

  it('every shard is a full copy of the old job: its own database and redis, real migrations, the seed', () => {
    expect(shardJob).toContain('image: postgis/postgis');
    expect(shardJob).toContain('image: redis:');
    expect(shardJob).toContain('npx prisma migrate deploy');
    expect(shardJob).toContain('npx prisma db seed');
    expect(shardJob).toContain('pnpm --filter @swift/api test -- --coverage');
    expect(shardJob).toMatch(/^ {6}fail-fast: false\s*$/m);
  });

  it('the shards report what ran, the aggregate proves the partition and merges results and coverage', () => {
    for (const reporter of ['default', 'github-actions', 'blob', 'junit']) expect(shardJob).toContain(`--reporter=${reporter}`);
    expect(aggregate).toContain('npx vitest list --filesOnly --json=');
    expect(aggregate).toContain('node ../../scripts/ci-api-shard-partition.mjs');
    expect(aggregate).toContain('npx vitest run --merge-reports=ci-shard-report/blob --coverage');
  });
});
