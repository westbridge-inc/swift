import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [STG-DRILLS] The journey runner's side of the drills. The runner stays an
// HTTP client: it READS the fixture manifest the server wrote, refuses one
// that is malformed, names a live phone (gate p) or was made on another
// deployment (gate b); a case proven only by the automated clock-driven gate
// never blocks a PASS but is named; the crash drill's once-only rule and its
// row replacement are pure and proven here. Imported by path, like
// livetest-guard.test.ts (scripts/ sits outside this package's rootDir).
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
let drills: any;
let journey: any;
let report: any;
let crash: any;
beforeAll(async () => {
  drills = await import(pathToFileURL(join(ROOT, 'scripts/livetest/drills.ts')).href);
  journey = await import(pathToFileURL(join(ROOT, 'scripts/livetest/journey.ts')).href);
  report = await import(pathToFileURL(join(ROOT, 'scripts/livetest/report.ts')).href);
  crash = await import(pathToFileURL(join(ROOT, 'scripts/livetest/crash-drill.ts')).href);
});

/** The shape apps/api/src/modules/ops/drills/fixtures.ts prints (its DB test feeds the real one through the same parser). */
function sampleManifest() {
  const acct = (slot: string, n: number) => ({ slot, userId: `u${n}`, phone: `+592048${String(1000 + n)}` });
  const store = (slot: string, n: number) => ({ ...acct(slot, n), vendorId: `v${n}`, vendorName: `DRILL-r1 ${slot}`, subscriptionId: `s${n}`, san: '1234567890', bornAs: 'TRIAL', trialEndedAt: '2026-09-15T00:00:00.000Z' });
  return {
    version: 1, runId: 'r1', marker: 'DRILL-r1', createdAt: '2026-09-30T00:00:00.000Z',
    target: { deploymentId: 'swift-staging-1', environment: 'staging', database: 'swift' },
    billing: { vend04: store('vend04-billing', 1), money03: store('money03-billing', 2) },
    recusal: { ...acct('admin01-applicant', 3), adminPhone: '+5920400000', linkedBy: 'PHONE' },
    tenant: {
      tenantId: 'swift-drill', kind: 'CRAWLER',
      customer: acct('plat01-customer', 4), storeOwner: acct('plat01-store-owner', 5), partner: { ...acct('plat01-partner', 6), riderId: 'r6' },
      store: { vendorId: 'v7', name: 'DRILL-r1 cross-tenant store', itemId: 'i7', itemName: 'DRILL-r1 plate' },
      order: { orderId: 'o8', orderNumber: 'SW-260930-000ABC' },
    },
  };
}

const gateOf = (fn: () => unknown): string | null => {
  try { fn(); } catch (e: any) { if (e?.name === 'TargetRefused') return e.gate; throw e; }
  return null;
};

describe('[STG-DRILLS] the fixture manifest the runner reads', () => {
  it('a well-formed manifest parses to the same ids and phones', () => {
    const m = drills.parseDrillManifest(sampleManifest());
    expect(m.billing.vend04.subscriptionId).toBe('s1');
    expect(m.tenant.order.orderId).toBe('o8');
    expect(drills.drillPhones(m)).toHaveLength(7);
  });

  it('a manifest that could reach a subscriber is refused before any request (gate p)', () => {
    const live = sampleManifest();
    live.tenant.customer.phone = '+5926001234';
    expect(gateOf(() => drills.parseDrillManifest(live))).toBe('p');
  });

  it('a malformed manifest is an error, never half-used', () => {
    for (const broken of [{}, { ...sampleManifest(), version: 2 }, { ...sampleManifest(), billing: {} }, { ...sampleManifest(), tenant: { ...sampleManifest().tenant, order: {} } }]) {
      expect(() => drills.parseDrillManifest(broken)).toThrow(/drill manifest/);
    }
  });

  it('a manifest made on another deployment is refused (gate b)', () => {
    const m = drills.parseDrillManifest(sampleManifest());
    expect(gateOf(() => drills.refuseForeignManifest(m, { deploymentId: 'swift-staging-1', environment: 'staging' }))).toBeNull();
    expect(gateOf(() => drills.refuseForeignManifest(m, { deploymentId: 'swift-staging-2', environment: 'staging' }))).toBe('b');
  });

  it('no LIVETEST_DRILL_MANIFEST means no drill fixtures (the run is exactly as before); an unreadable file is an error', () => {
    expect(drills.loadDrillManifest({})).toBeNull();
    expect(drills.loadDrillManifest({ LIVETEST_DRILL_MANIFEST: '  ' })).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'drill-manifest-'));
    try {
      writeFileSync(join(dir, 'm.json'), '{ not json');
      expect(() => drills.loadDrillManifest({ LIVETEST_DRILL_MANIFEST: join(dir, 'm.json') })).toThrow(/not a readable JSON file/);
      writeFileSync(join(dir, 'ok.json'), JSON.stringify(sampleManifest()));
      expect(drills.loadDrillManifest({ LIVETEST_DRILL_MANIFEST: join(dir, 'ok.json') }).marker).toBe('DRILL-r1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('[STG-DRILLS] an automated-only (clock) case', () => {
  const target = { deploymentId: 'd', environment: 'staging', buildSha: 'b' };
  const finish = (build: (rec: any) => void) => {
    const run = new journey.JourneyRun({ id: 'VEND-04', title: 't', cases: 'c', run: async () => undefined });
    build(run.rec);
    return run.result(target, 'r1');
  };

  it('does not block a PASS, and is named as the automated gate’s proof', () => {
    const r = finish((rec) => {
      rec.step('the bill is settled', true, '');
      rec.deny('a customer cannot read it', { status: 403, ok: false, json: null, text: '' }, [403]);
      rec.automatedCase('suspension/reinstatement', 'proven by GOLD-2 VEND-04');
    });
    expect(r.status).toBe('PASS');
    expect(r.reason).toContain('automated-only (clock), proven by the automated gate: suspension/reinstatement (proven by GOLD-2 VEND-04)');
    expect(r.skippedCases).toEqual([{ case: 'suspension/reinstatement', reason: 'proven by GOLD-2 VEND-04', gate: 'automated' }]);
  });

  it('a target skip still makes the journey SKIP, automated case or not', () => {
    const r = finish((rec) => {
      rec.step('x', true, '');
      rec.deny('d', { status: 403, ok: false, json: null, text: '' }, [403]);
      rec.automatedCase('suspension/reinstatement', 'clock');
      rec.skipCase('agent cash', 'no second admin');
    });
    expect(r.status).toBe('SKIP');
  });

  it('the summary marks it AUTOMATED-ONLY, not SKIP', () => {
    const r = finish((rec) => {
      rec.step('x', true, '');
      rec.deny('d', { status: 403, ok: false, json: null, text: '' }, [403]);
      rec.automatedCase('suspension/reinstatement', 'clock');
    });
    const md = report.summaryMarkdown({ runId: 'r1', baseUrl: 'http://api-journeys:3000', target: { ...target, dataClassification: 'synthetic', testTenant: 't' }, startedAt: 'a', finishedAt: 'b' }, [r]);
    expect(md).toContain('- AUTOMATED-ONLY suspension/reinstatement — clock');
    expect(md).toContain('automated-only: suspension/reinstatement: clock');
  });
});

describe('[STG-DRILLS D7] the crash drill’s once-only verdict', () => {
  const s = (moverId: string, offerAttemptId: string) => ({ at: 0, moverId, offerAttemptId });

  it('one holder at a time, attempts moving forward, is once-only', () => {
    expect(crash.onceOnly([[s('DR1', 'a1')], [], [s('DR2', 'a2')], [s('DR2', 'a2')]]).ok).toBe(true);
  });
  it('two riders holding live offers for the order at the same moment ran twice', () => {
    const v = crash.onceOnly([[s('DR1', 'a1')], [s('DR1', 'a1'), s('DR2', 'a2')]]);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('DR1 and DR2 held live offers');
  });
  it('a replaced attempt that comes back ran twice', () => {
    const v = crash.onceOnly([[s('DR1', 'a1')], [s('DR2', 'a2')], [s('DR1', 'a1')]]);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('a1 came back');
  });
  it('the window is the promise: 120 s', () => {
    expect(crash.RESUME_WINDOW_MS).toBe(120_000);
  });
});

describe('[STG-DRILLS D7] a later proof replaces the run’s own row', () => {
  const row = (id: string, status: string) => ({ journeyId: id, title: id, status, steps: [], skippedCases: [], startedAt: `2026-09-30T00:0${id.length}:00Z`, finishedAt: '2026-09-30T00:09:00Z', target: { deploymentId: 'd', environment: 'staging', buildSha: 'b' }, runId: 'r1' });

  it('replaceJourneyRow swaps the row in place, and adds one the run never had', () => {
    const results = [row('PLAT-01', 'PASS'), row('PLAT-02', 'SKIP'), row('PLAT-03', 'PASS')];
    const merged = report.replaceJourneyRow(results, row('PLAT-02', 'PASS'));
    expect(merged.map((r: any) => `${r.journeyId}:${r.status}`)).toEqual(['PLAT-01:PASS', 'PLAT-02:PASS', 'PLAT-03:PASS']);
    expect(results[1]!.status).toBe('SKIP');
    expect(report.replaceJourneyRow([row('PLAT-01', 'PASS')], row('PLAT-02', 'FAIL')).map((r: any) => r.journeyId)).toEqual(['PLAT-01', 'PLAT-02']);
  });

  it('writeReplacedRow keeps the original once, rewrites the results and a summary whose counts are true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-results-'));
    try {
      writeFileSync(join(dir, 'journeys-result.json'), JSON.stringify([row('PLAT-01', 'PASS'), row('PLAT-02', 'SKIP')]));
      const meta = { runId: 'r1', baseUrl: 'http://api-journeys:3000', target: { deploymentId: 'd', environment: 'staging', buildSha: 'b', dataClassification: 'synthetic', testTenant: 't' } };
      const out = report.writeReplacedRow(dir, 'plat02-crash-drill.json', row('PLAT-02', 'PASS'), meta);
      expect(JSON.parse(readFileSync(out.row, 'utf8')).status).toBe('PASS');
      expect(JSON.parse(readFileSync(join(dir, 'journeys-result.json'), 'utf8')).map((r: any) => r.status)).toEqual(['PASS', 'PASS']);
      expect(JSON.parse(readFileSync(join(dir, 'journeys-result.before-plat02-crash-drill.json'), 'utf8'))[1].status).toBe('SKIP');
      expect(readFileSync(join(dir, 'journeys-summary.md'), 'utf8')).toContain('**2 PASS · 0 FAIL · 0 SKIP** of 2 journeys.');
      // A second drill run keeps the ORIGINAL backup, not the first drill's result.
      report.writeReplacedRow(dir, 'plat02-crash-drill.json', row('PLAT-02', 'FAIL'), meta);
      expect(JSON.parse(readFileSync(join(dir, 'journeys-result.before-plat02-crash-drill.json'), 'utf8'))[1].status).toBe('SKIP');
      expect(JSON.parse(readFileSync(join(dir, 'journeys-result.json'), 'utf8'))[1].status).toBe('FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a journeys-result.json the row stands alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-results-'));
    try {
      const out = report.writeReplacedRow(dir, 'plat02-crash-drill.json', row('PLAT-02', 'PASS'), { runId: 'r1', baseUrl: 'x', target: { deploymentId: 'd', environment: 'staging', buildSha: 'b', dataClassification: 'synthetic', testTenant: 't' } });
      expect(out.merged).toBeNull();
      expect(existsSync(join(dir, 'journeys-result.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
