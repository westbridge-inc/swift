import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [STG-DRILLS] The journey runner's side of the drills. The runner stays an
// HTTP client: it READS the fixture manifest the server wrote, refuses one
// that is malformed, names a live phone (gate p) or was made on another
// deployment (gate b); a case proven only by an automated gate makes the
// journey SKIP and is reported apart, never a PASS (AX324 R6); ADMIN-04 never
// touches a digest of a store the run does not own (R4); the crash drill's
// live and durable once-only rules (R7), its empty dead-letter rule (R8) and
// its row replacement are pure and proven here, as are receipt ids that keep
// their case suffix (R9). Imported by path, like livetest-guard.test.ts
// (scripts/ sits outside this package's rootDir).
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
let drills: any;
let journey: any;
let report: any;
let crash: any;
let common: any;
let admin: any;
beforeAll(async () => {
  drills = await import(pathToFileURL(join(ROOT, 'scripts/livetest/drills.ts')).href);
  journey = await import(pathToFileURL(join(ROOT, 'scripts/livetest/journey.ts')).href);
  report = await import(pathToFileURL(join(ROOT, 'scripts/livetest/report.ts')).href);
  crash = await import(pathToFileURL(join(ROOT, 'scripts/livetest/crash-drill.ts')).href);
  common = await import(pathToFileURL(join(ROOT, 'scripts/livetest/journeys/common.ts')).href);
  admin = await import(pathToFileURL(join(ROOT, 'scripts/livetest/journeys/admin.ts')).href);
});

/** The shape apps/api/src/modules/ops/drills/fixtures.ts prints (its DB test feeds the real one through the same parser). */
function sampleManifest() {
  const acct = (slot: string, n: number) => ({ slot, userId: `u${n}`, phone: `+592048${String(1000 + n)}` });
  return {
    version: 2, runId: 'r1', marker: 'DRILL-r1', createdAt: '2026-09-30T00:00:00.000Z',
    target: { deploymentId: 'swift-staging-1', environment: 'staging', database: 'swift' },
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
    expect(m.recusal.userId).toBe('u3');
    expect(m.tenant.order.orderId).toBe('o8');
    expect(drills.drillPhones(m)).toHaveLength(5);
  });

  it('[AX324 R2] a version-1 manifest (the retired billing fixtures) is refused, never half-used', () => {
    expect(() => drills.parseDrillManifest({ ...sampleManifest(), version: 1 })).toThrow(/version-2/);
  });

  it('a manifest that could reach a subscriber is refused before any request (gate p)', () => {
    const live = sampleManifest();
    live.tenant.customer.phone = '+5926001234';
    expect(gateOf(() => drills.parseDrillManifest(live))).toBe('p');
  });

  it('a malformed manifest is an error, never half-used', () => {
    for (const broken of [{}, { ...sampleManifest(), version: 3 }, { ...sampleManifest(), recusal: {} }, { ...sampleManifest(), tenant: { ...sampleManifest().tenant, order: {} } }]) {
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

describe('[AX324 R6] an automated-only case is never a PASS on a live target', () => {
  const target = { deploymentId: 'd', environment: 'staging', buildSha: 'b' };
  const finish = (build: (rec: any) => void) => {
    const run = new journey.JourneyRun({ id: 'VEND-04', title: 't', cases: 'c', run: async () => undefined });
    build(run.rec);
    return run.result(target, 'r1');
  };
  const denied = { status: 403, ok: false, json: null, text: '' };

  it('makes the journey SKIP even when every executed step passed — the evidence is named apart', () => {
    const r = finish((rec) => {
      rec.step('the bill is settled', true, '');
      rec.deny('a customer cannot read it', denied, [403]);
      rec.automatedCase('suspension/reinstatement', 'proven by GOLD-7 VEND-04');
    });
    expect(r.status).toBe('SKIP');
    expect(r.reason).toContain('server cases NOT executed on this target — automated evidence, reported separately and never a PASS here: suspension/reinstatement (proven by GOLD-7 VEND-04)');
    expect(r.skippedCases).toEqual([{ case: 'suspension/reinstatement', reason: 'proven by GOLD-7 VEND-04', gate: 'automated' }]);
  });

  it('with a target skip beside it, both are named; a failed step still makes it FAIL', () => {
    const r = finish((rec) => {
      rec.step('x', true, '');
      rec.deny('d', denied, [403]);
      rec.automatedCase('suspension/reinstatement', 'clock');
      rec.skipCase('agent cash', 'no second admin');
    });
    expect(r.status).toBe('SKIP');
    expect(r.reason).toContain('cannot run on this target: agent cash (no second admin)');
    expect(r.reason).toContain('automated evidence, reported separately and never a PASS here: suspension/reinstatement (clock)');
    const failed = finish((rec) => {
      rec.step('x', false, 'broke');
      rec.deny('d', denied, [403]);
      rec.automatedCase('suspension/reinstatement', 'clock');
    });
    expect(failed.status).toBe('FAIL');
  });

  it('a device-gate case alone still permits a PASS (the ledger’s separate device gate)', () => {
    const r = finish((rec) => {
      rec.step('x', true, '');
      rec.deny('d', denied, [403]);
      rec.deviceCase('SMS on a real SIM', 'device gate');
    });
    expect(r.status).toBe('PASS');
  });

  it('the summary reports the automated evidence in its own section, and the journey row says SKIP', () => {
    const r = finish((rec) => {
      rec.step('x', true, '');
      rec.deny('d', denied, [403]);
      rec.automatedCase('suspension/reinstatement', 'clock');
    });
    const md = report.summaryMarkdown({ runId: 'r1', baseUrl: 'http://api-journeys:3000', target: { ...target, dataClassification: 'synthetic', testTenant: 't' }, startedAt: 'a', finishedAt: 'b' }, [r]);
    expect(md).toContain('**0 PASS · 0 FAIL · 1 SKIP**');
    expect(md).toContain('- NOT RUN HERE suspension/reinstatement — clock');
    expect(md).toContain('## Automated evidence (reported separately — never a PASS on this target)');
    expect(md).toContain('- VEND-04 (SKIP) · suspension/reinstatement — clock');
  });
});

describe('[AX324 R4] ADMIN-04 touches only a digest of a store the run owns', () => {
  type Call = { method: string; path: string };
  const OWNER_DIGEST = { id: 'dig-owner', kind: 'DIGEST', status: 'PENDING', vendorId: 'v-owner-real', vendor: { name: 'The owner’s own staging store' }, totalOrders: 9, netSales: 12000 };
  const RUN_DIGEST = { id: 'dig-r1', kind: 'DIGEST', status: 'PENDING', vendorId: 'v-r1', vendor: { name: 'R1' }, totalOrders: 1, netSales: 1500 };
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  /** A stand-in API: the owner's real store has a pending digest; the run's own R1 may have one. */
  function fakeApi(digests: any[]): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = String(init?.method ?? 'GET');
      const auth = String(init?.headers?.authorization ?? '');
      calls.push({ method, path: `${path}${url.search}` });
      const body = (status: number, json: unknown) => ({ status, text: async () => JSON.stringify(json) }) as unknown as Response;
      if (auth.endsWith('tok-R1') && method !== 'GET') return body(403, { success: false, error: { code: 'FORBIDDEN' } });
      if (path === '/vendor/profile') return body(200, { success: true, data: { vendors: [{ id: auth.endsWith('tok-R1') ? 'v-r1' : 'v-r2', status: 'ACTIVE' }] } });
      if (path === '/admin/finance/settlements') {
        const vendorId = url.searchParams.get('vendorId');
        return body(200, { success: true, data: digests.filter((d) => !vendorId || d.vendorId === vendorId) });
      }
      if (path === '/vendor/subscription') return body(200, { success: true, data: { san: '1234567890', walletBalanceGyd: 0 } });
      return body(200, { success: true, data: {} });
    }) as unknown as typeof fetch;
    return calls;
  }
  const ctx = () => ({
    runId: 'r4', log: () => undefined, adminPhone: '+5920400000', admin: { token: 'tok-admin', userId: 'a' },
    roster: { customers: {}, movers: {}, providers: {}, admin2: null, vendors: { R1: { id: 'R1', session: { token: 'tok-R1', userId: 'u1' }, vendorId: 'v-r1' } } },
    world: {}, stash: {}, drill: null,
  });
  const touched = (calls: Call[], id: string) => calls.filter((c) => c.path.includes(`/settlements/${id}/`));

  it('with only the owner’s digest pending, nothing is acknowledged or adjusted — the case is SKIP', async () => {
    const calls = fakeApi([OWNER_DIGEST]);
    const rec = new journey.Recorder();
    await admin.ADMIN_04.run(rec, ctx());
    expect(touched(calls, 'dig-owner')).toEqual([]);
    expect(rec.skipped).toContainEqual(expect.objectContaining({ case: 'process a weekly settlement digest', gate: 'target' }));
    // The shared list was never the source of a candidate: every digest query named the verified store.
    const digestQueries = calls.filter((c) => c.path.startsWith('/admin/finance/settlements?'));
    expect(digestQueries.length).toBeGreaterThan(0);
    for (const q of digestQueries) expect(q.path).toContain('vendorId=v-r1');
  });

  it('with the run’s own digest pending too, only that one is processed', async () => {
    const calls = fakeApi([OWNER_DIGEST, RUN_DIGEST]);
    const rec = new journey.Recorder();
    await admin.ADMIN_04.run(rec, ctx());
    expect(touched(calls, 'dig-owner')).toEqual([]);
    expect(touched(calls, 'dig-r1').map((c) => `${c.method} ${c.path}`)).toContain('PUT /admin/finance/settlements/dig-r1/process');
  });

  it('a roster store whose own profile does not confirm the id is not the run’s: its digest is never selected', async () => {
    const calls = fakeApi([{ ...RUN_DIGEST, id: 'dig-x', vendorId: 'v-x' }]);
    const rec = new journey.Recorder();
    const c = ctx();
    c.roster.vendors.R1.vendorId = 'v-x';
    await admin.ADMIN_04.run(rec, c);
    expect(touched(calls, 'dig-x')).toEqual([]);
  });
});

describe('[AX324 R9] receipt ids keep their case suffix', () => {
  it('a 64-character run id: every case gets its own id, within the 64-character field, ending in its tag', () => {
    const run64 = 'r'.repeat(64);
    const ids = ['M03', 'A04', 'V04'].map((t) => common.runReceipt(run64, t));
    expect(new Set(ids).size).toBe(3);
    for (const [i, t] of ['M03', 'A04', 'V04'].entries()) {
      expect(ids[i]!.length).toBeLessThanOrEqual(64);
      expect(ids[i]!.endsWith(`-${t}`)).toBe(true);
    }
    // The truncation it replaces collided exactly here.
    expect(`DRILL-${run64}-V04`.slice(0, 64)).toBe(`DRILL-${run64}-M03`.slice(0, 64));
  });

  it('run ids that share any prefix never share a receipt', () => {
    const a = `${'staging-20260930T000000Z-'.padEnd(63, 'x')}a`;
    const b = `${'staging-20260930T000000Z-'.padEnd(63, 'x')}b`;
    expect(common.runReceipt(a, 'M03')).not.toBe(common.runReceipt(b, 'M03'));
    expect(common.runReceipt('a.b', 'M03')).not.toBe(common.runReceipt('a_b', 'M03'));
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

describe('[AX324 R7] once-only over the whole window: every holder, through completion', () => {
  const s = (moverId: string, offerAttemptId: string) => ({ at: 0, moverId, offerAttemptId });

  it('holders: one rider at a time and only one ever', () => {
    expect(crash.holdersVerdict([[], ['DR2'], ['DR2'], []]).ok).toBe(true);
    const twoAtOnce = crash.holdersVerdict([['DR1', 'DR2']]);
    expect(twoAtOnce.ok).toBe(false);
    expect(twoAtOnce.detail).toContain('DR1 and DR2 held the order at the same moment');
    const handedTwice = crash.holdersVerdict([['DR1'], [], ['DR2']]);
    expect(handedTwice.ok).toBe(false);
    expect(handedTwice.detail).toContain('handed out more than once');
    expect(crash.holdersVerdict([[], []]).ok).toBe(false);
  });

  it('no live offer for the order once it is assigned — through completion', () => {
    expect(crash.noOfferAfterAssignment([[], [], []]).ok).toBe(true);
    const late = crash.noOfferAfterAssignment([[], [s('DR3', 'a3')]]);
    expect(late.ok).toBe(false);
    expect(late.detail).toContain('DR3/a3');
  });
});

describe('[AX324 R7] the durable once-only verdict', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 8, 30, 10, 0, s)).toISOString();
  const clean = () => ({
    version: 1, orderId: 'o1', readAt: t(59),
    order: { status: 'DELIVERED', riderId: 'r-dr2' },
    offers: [
      { attemptId: 'a1', recipientId: 'u-dr1', sentAt: t(1), acknowledgedAt: null },
      { attemptId: 'a2', recipientId: 'u-dr2', sentAt: t(20), acknowledgedAt: t(21) },
    ],
    offerPushes: [{ attemptId: 'a1', userId: 'u-dr1', createdAt: t(1) }, { attemptId: 'a2', userId: 'u-dr2', createdAt: t(20) }],
    searches: [{ id: 's1', status: 'ASSIGNED', wave: 1, startedAt: t(0), assignedAt: t(21), assignedTo: 'r-dr2', deliveryAuthorityVersion: 0 }],
    statusLog: ['PENDING', 'ACCEPTED', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'DELIVERED'].map((status, i) => ({ status, createdAt: t(i === 0 ? 0 : 20 + i) })),
  });
  const failing = (e: any, accepted = 'a2') => crash.durableOnceOnly(e, accepted).filter((c: any) => !c.ok).map((c: any) => c.name);

  it('a clean crash window passes every rule', () => {
    expect(failing(clean())).toEqual([]);
  });

  it('an attempt published twice (the publish job ran again after the restart)', () => {
    const e = clean();
    e.offers.push({ ...e.offers[1]! });
    expect(failing(e)).toEqual(['durable: every offer attempt was published once (alert deliveries)']);
  });

  it('a new attempt published after the order was assigned — but the accepted attempt racing its own row is not a duplicate', () => {
    const e = clean();
    e.offers.push({ attemptId: 'a3', recipientId: 'u-dr3', sentAt: t(40), acknowledgedAt: null });
    expect(failing(e)).toContain('durable: no new offer was published after the order was assigned');
    const race = clean();
    race.offers[1] = { ...race.offers[1]!, sentAt: t(23) };
    expect(failing(race)).toEqual([]);
  });

  it('an attempt pushed twice', () => {
    const e = clean();
    e.offerPushes.push({ attemptId: 'a1', userId: 'u-dr1', createdAt: t(2) });
    expect(failing(e)).toEqual(['durable: every offer attempt was pushed at most once (dispatch_offer notifications)']);
  });

  it('a status logged twice: an assignment or a delivery that ran again', () => {
    const e = clean();
    e.statusLog.push({ status: 'RIDER_ASSIGNED', createdAt: t(50) });
    expect(failing(e)).toEqual(['durable: every order status was logged once — one assignment, one delivery']);
    const never = clean();
    never.statusLog = never.statusLog.filter((l) => l.status !== 'DELIVERED');
    expect(failing(never)).toContain('durable: every order status was logged once — one assignment, one delivery');
  });

  it('the dispatch journal assigning the order twice', () => {
    const e = clean();
    e.searches.push({ ...e.searches[0]!, id: 's2' });
    expect(failing(e)).toEqual(['durable: the dispatch journal assigned the order at most once']);
  });

  it('no publication at all, an unattributed publication, or an order that did not end delivered', () => {
    expect(failing({ ...clean(), offers: [] })).toContain('durable: every offer attempt was published once (alert deliveries)');
    const anon = clean();
    anon.offers.push({ attemptId: null as any, recipientId: 'u-dr1', sentAt: t(2), acknowledgedAt: null });
    expect(failing(anon)).toContain('durable: every offer attempt was published once (alert deliveries)');
    expect(failing({ ...clean(), order: { status: 'EN_ROUTE_DELIVERY', riderId: 'r-dr2' } })).toEqual(['durable: the order ends delivered, with its one rider']);
  });
});

describe('[AX324 R8] PLAT-02 needs a valid, EMPTY dead-letter page', () => {
  it('only an empty page from a successful read passes — nothing is filtered away', () => {
    expect(crash.dlqVerdict({ ok: true, json: { success: true, data: [] } })).toMatchObject({ ok: true, count: 0 });
    const old = crash.dlqVerdict({ ok: true, json: { success: true, data: [{ queue: 'order', name: 'x', finishedOn: 1, failedReason: 'before the drill' }] } });
    expect(old).toMatchObject({ ok: false, count: 1 });
    expect(old.detail).toContain('order/x before the drill');
    for (const bad of [{ ok: false, json: null }, { ok: true, json: { success: true, data: null } }, { ok: true, json: { success: false, data: [] } }, { ok: true, json: null }]) {
      expect(crash.dlqVerdict(bad), JSON.stringify(bad)).toMatchObject({ ok: false, count: null });
    }
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
