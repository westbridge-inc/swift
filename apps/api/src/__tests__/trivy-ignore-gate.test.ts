import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// The dependency-scan suppression gate (scripts/trivy-ignore-gate.mjs).
//
// The CI Security Scan blocks on every HIGH/CRITICAL advisory in the lockfile.
// When an advisory has no fixed release and is not reachable in what we ship,
// it may be suppressed in .trivyignore.yaml, but only as a scoped, dated,
// explained entry: one package@version, an expiry no more than 31 days out, a
// statement with a tracking note. A suppression without an expiry would hide
// the advisory forever, so the gate runs before the scan and refuses it. These
// tests drive the real script against fixture files and pin every refusal: a
// gate that fails open is silent, so silence is what they guard against.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'trivy-ignore-gate.mjs');
const TODAY = '2026-10-04';

let root: string;

function run(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '' },
    });
    return { code: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const STATEMENT = [
  '    statement: >-',
  '      Pulled in only by build tooling; not in the API closure and never fed',
  '      untrusted input. Added 2026-10-04. Tracking: bump when a fix ships.',
];

function entry(over: { id?: string; purls?: string[] | null; expires?: string | null; statement?: string[] | null; extra?: string[] } = {}): string[] {
  const lines = [`  - id: ${over.id ?? 'CVE-2026-93687'}`];
  if (over.purls !== null) {
    lines.push('    purls:');
    for (const p of over.purls ?? ['pkg:npm/braces@3.0.3']) lines.push(`      - ${p}`);
  }
  if (over.expires !== null) lines.push(`    expired_at: ${over.expires ?? '2026-11-03'}`);
  if (over.statement !== null) lines.push(...(over.statement ?? STATEMENT));
  lines.push(...(over.extra ?? []));
  return lines;
}

/** A refusal is exit 1 WITH the gate's own verdict line: a crash or a missing script also exits 1. */
function refused(r: { code: number; output: string }, why?: string): void {
  expect(r.code, r.output).toBe(1);
  expect(r.output, why).toMatch(/^trivy-ignore-gate: REFUSED/m);
}

function gate(lines: string[], extraArgs: string[] = []): { code: number; output: string } {
  const dir = mkdtempSync(join(root, 'case-'));
  writeFileSync(join(dir, '.trivyignore.yaml'), ['# header comment', '', ...lines, ''].join('\n'));
  return run(['--root', dir, '--today', TODAY, ...extraArgs]);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'trivy-ignore-gate-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('trivy ignore gate: accepts what the policy allows', () => {
  it('passes a scoped, dated, explained entry', () => {
    const r = gate(['vulnerabilities:', ...entry()]);
    expect(r.output).toContain('1 suppression');
    expect(r.code).toBe(0);
  });

  it('passes several entries, scoped packages and an expiry exactly 31 days out', () => {
    const r = gate([
      'vulnerabilities:',
      ...entry(),
      '',
      ...entry({ id: 'GHSA-x8mw-p69m-v3mx', purls: ['pkg:npm/%40fastify/busboy@3.2.0', 'pkg:npm/@fastify/busboy@3.1.1'], expires: '2026-11-04' }),
    ]);
    expect(r.output).toContain('2 suppressions');
    expect(r.code).toBe(0);
  });

  it('passes an empty list', () => {
    const r = gate(['vulnerabilities: []']);
    expect(r.code).toBe(0);
  });

  it('passes the real repository file today', () => {
    const r = run(['--root', REPO]);
    expect(r.code).toBe(0);
  });
});

describe('trivy ignore gate: refuses an entry with no expiry or a bad one', () => {
  it('refuses an entry with no expired_at', () => {
    const r = gate(['vulnerabilities:', ...entry({ expires: null })]);
    refused(r);
    expect(r.output).toMatch(/CVE-2026-93687.*expired_at/);
  });

  it('refuses an expiry more than 31 days out', () => {
    const r = gate(['vulnerabilities:', ...entry({ expires: '2026-11-05' })]);
    refused(r);
    expect(r.output).toMatch(/CVE-2026-93687.*more than 31 days/);
  });

  it('refuses an expiry that has already passed', () => {
    const r = gate(['vulnerabilities:', ...entry({ expires: '2026-10-03' })]);
    refused(r);
    expect(r.output).toMatch(/CVE-2026-93687.*expired/);
  });

  it('refuses an expiry of today (Trivy already drops it), accepts tomorrow, refuses a malformed or impossible date', () => {
    refused(gate(['vulnerabilities:', ...entry({ expires: TODAY })]));
    expect(gate(['vulnerabilities:', ...entry({ expires: '2026-10-05' })]).code).toBe(0);
    refused(gate(['vulnerabilities:', ...entry({ expires: '2026-11-3' })]));
    refused(gate(['vulnerabilities:', ...entry({ expires: '2026-02-30' })]));
    refused(gate(['vulnerabilities:', ...entry({ expires: 'never' })]));
  });

  it('honours --max-days', () => {
    refused(gate(['vulnerabilities:', ...entry({ expires: '2026-10-20' })], ['--max-days', '10']));
    expect(gate(['vulnerabilities:', ...entry({ expires: '2026-10-14' })], ['--max-days', '10']).code).toBe(0);
  });
});

describe('trivy ignore gate: refuses an unscoped or unexplained entry', () => {
  it('refuses an entry with no purls', () => {
    const r = gate(['vulnerabilities:', ...entry({ purls: null })]);
    refused(r);
    expect(r.output).toMatch(/CVE-2026-93687.*purls/);
  });

  it('refuses a purl without an exact version', () => {
    for (const p of ['pkg:npm/braces', 'pkg:npm/braces@*', 'pkg:npm/braces@3.x', 'pkg:pypi/braces@3.0.3']) {
      const r = gate(['vulnerabilities:', ...entry({ purls: [p] })]);
      refused(r, p);
    }
  });

  it('refuses an entry scoped by paths instead of a purl', () => {
    const r = gate(['vulnerabilities:', ...entry({ extra: ['    paths:', '      - "pnpm-lock.yaml"'] })]);
    refused(r);
    expect(r.output).toMatch(/paths/);
  });

  it('refuses an entry with no statement, or one with no tracking note', () => {
    refused(gate(['vulnerabilities:', ...entry({ statement: null })]));
    const r = gate(['vulnerabilities:', ...entry({ statement: ['    statement: Build tooling only, never reachable with untrusted input here.'] })]);
    refused(r);
    expect(r.output).toMatch(/Tracking/);
  });

  it('refuses an ID that is not a CVE or GHSA identifier', () => {
    for (const id of ['*', 'CVE-2026-*', 'braces']) {
      refused(gate(['vulnerabilities:', ...entry({ id })]), id);
    }
  });
});

describe('trivy ignore gate: refuses anything outside the vulnerability list', () => {
  it('refuses secret, licence and misconfiguration sections', () => {
    for (const section of ['secrets', 'licenses', 'misconfigurations']) {
      const r = gate(['vulnerabilities:', ...entry(), `${section}:`, '  - id: anything']);
      refused(r, section);
      expect(r.output).toContain(section);
    }
  });

  it('refuses an unknown key inside an entry', () => {
    const r = gate(['vulnerabilities:', ...entry({ extra: ['    severity: LOW'] })]);
    refused(r);
    expect(r.output).toMatch(/severity/);
  });

  it('refuses a missing ignore file and a leftover plain .trivyignore', () => {
    const empty = mkdtempSync(join(root, 'none-'));
    refused(run(['--root', empty, '--today', TODAY]));

    const legacy = mkdtempSync(join(root, 'legacy-'));
    writeFileSync(join(legacy, '.trivyignore.yaml'), ['vulnerabilities:', ...entry(), ''].join('\n'));
    writeFileSync(join(legacy, '.trivyignore'), 'CVE-2026-93687\n');
    const r = run(['--root', legacy, '--today', TODAY]);
    refused(r);
    expect(r.output).toContain('.trivyignore');
  });
});

describe('the Security Scan job runs the gate and hands Trivy the scoped file', () => {
  // The gate only protects anything if CI runs it before the scan, and the dated,
  // scoped entries only mean anything if Trivy reads THAT file (it does not pick up
  // .trivyignore.yaml on its own).
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const start = workflow.indexOf('name: Security Scan');
  const rest = workflow.slice(start);
  const nextJob = rest.search(/\n {2}[a-z][\w-]*:\n/);
  const job = nextJob === -1 ? rest : rest.slice(0, nextJob);

  it('finds the job', () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toContain('trivy fs');
  });

  it('runs the gate before the scan', () => {
    const gateAt = job.indexOf('run: node scripts/trivy-ignore-gate.mjs');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(job.indexOf('trivy fs'));
  });

  it('scans the lockfile at HIGH+ with a blocking exit code and the scoped ignore file', () => {
    const scan = job.split('\n').find((l) => l.includes('trivy fs')) ?? '';
    expect(scan).toContain('--scanners vuln');
    expect(scan).toContain('--severity HIGH,CRITICAL');
    expect(scan).toContain('--exit-code 1');
    expect(scan).toContain('--ignorefile .trivyignore.yaml');
    expect(scan.trim().endsWith('pnpm-lock.yaml')).toBe(true);
    expect(job).not.toMatch(/continue-on-error|\|\|\s*true|--ignore-unfixed|--skip-db-update/);
  });
});
