import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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
    order: { tenantId: `drill-crash-${createHash('sha256').update('r-a3').digest('hex').slice(0, 32)}`, status: 'DELIVERED', riderId: 'r-dr2' },
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

  // [AX370 A3] Publication is tracked AFTER the socket emit and a failed write
  // is swallowed, so a MISSING row proves nothing: incomplete evidence is
  // INCONCLUSIVE, never a PASS — and never dressed up as a found duplicate.
  const gaps = (e: any, accepted: string | null, observed: string[]) =>
    crash.durableOnceOnly(e, accepted, observed).filter((c: any) => !c.ok);

  it('[AX370 A3] the reviewer’s case — accepted attempt a2 and every search dropped from the clean evidence — is not a pass: INCONCLUSIVE', () => {
    const e = clean();
    e.offers = e.offers.filter((o) => o.attemptId !== 'a2');
    e.searches = [];
    const open = gaps(e, 'a2', ['a1', 'a2']);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((c: any) => c.inconclusive === true)).toBe(true);
    const said = open.map((c: any) => c.detail).join(' | ');
    expect(said).toContain('a2');
    expect(said).toContain('no search');
    expect(said).toContain('no assignment');
  });

  it('[AX370 A3] each gap alone is INCONCLUSIVE: the accepted attempt unpublished; no search; a search that never assigned; an attempt a rider saw without a record', () => {
    const unpublished = clean();
    unpublished.offers = unpublished.offers.filter((o) => o.attemptId !== 'a2');
    unpublished.offerPushes = unpublished.offerPushes.filter((p) => p.attemptId !== 'a2');
    const noSearch = { ...clean(), searches: [] };
    const neverAssigned = clean();
    neverAssigned.searches = [{ ...neverAssigned.searches[0]!, status: 'EXHAUSTED', assignedAt: null as any, assignedTo: null as any }];
    for (const [label, e, observed] of [['unpublished', unpublished, ['a1']], ['no search', noSearch, ['a1', 'a2']], ['never assigned', neverAssigned, ['a1', 'a2']], ['unseen', clean(), ['a1', 'a2', 'a9']]] as const) {
      const open = gaps(e, 'a2', [...observed]);
      expect(open.length, label).toBeGreaterThan(0);
      expect(open.every((c: any) => c.inconclusive === true), label).toBe(true);
    }
    expect(gaps(clean(), 'a2', ['a1', 'a2', 'a9']).map((c: any) => c.detail).join(' ')).toContain('a9');
  });

  it('[AX370 A3] complete evidence — exactly one assignment, every attempt seen or accepted on record — passes; two assignments stay a FAIL, not a gap', () => {
    expect(gaps(clean(), 'a2', ['a1', 'a2'])).toEqual([]);
    const twiceAssigned = clean();
    twiceAssigned.searches.push({ ...twiceAssigned.searches[0]!, id: 's2' });
    const open = gaps(twiceAssigned, 'a2', ['a1', 'a2']);
    expect(open.map((c: any) => c.name)).toEqual(['durable: the dispatch journal assigned the order at most once']);
    expect(open[0].inconclusive).toBeFalsy();
  });

  it('[AX370 A3] finalize: the reviewer’s case makes the PLAT-02 row INCONCLUSIVE (SKIP, never PASS); the clean evidence is a PASS', async () => {
    const identity = { deploymentId: 'd', environment: 'staging', buildSha: 'b', dataClassification: 'synthetic', testTenant: 't' };
    const rowFor = async (evidence: any, observed = ['a1', 'a2'], writeVerify = true) => {
      const dir = mkdtempSync(join(tmpdir(), 'crash-final-'));
      try {
        writeFileSync(join(dir, 'crash-drill-state.json'), JSON.stringify({ runId: 'r-a3', setupStartedAt: t(0), tenantId: `drill-crash-${createHash('sha256').update('r-a3').digest('hex').slice(0, 32)}`, riderUsers: ['u-dr1', 'u-dr2', 'u-dr3'], orderId: 'o1', offer: { moverId: 'DR1', offerAttemptId: 'a1', seenAt: t(1) }, steps: [{ name: 'mid-offer', ok: true, detail: '' }], negatives: 0 }));
        if (writeVerify) writeFileSync(join(dir, 'crash-drill-verify.json'), JSON.stringify({ runId: 'r-a3', orderId: 'o1', steps: [{ name: 'resumed', ok: true, detail: '' }], negatives: 1, acceptedAttemptId: 'a2', observedAttemptIds: observed, finishedAt: t(58) }));
        writeFileSync(join(dir, 'crash-drill-evidence.json'), JSON.stringify(evidence));
        await crash.crashFinalize({ runId: 'r-a3', identity, admin: { token: 'x', userId: 'x' }, adminPhone: '+5920400000', outDir: dir, log: () => undefined });
        return JSON.parse(readFileSync(join(dir, 'plat02-crash-drill.json'), 'utf8'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect((await rowFor(clean())).status).toBe('PASS');
    const reviewer = clean();
    reviewer.offers = reviewer.offers.filter((o) => o.attemptId !== 'a2');
    reviewer.searches = [];
    const row = await rowFor(reviewer);
    expect(row.status).toBe('SKIP');
    expect(row.reason).toMatch(/^INCONCLUSIVE/);
    expect(row.reason).toContain('a2');
    // An attempt the verify phase saw, with no publication record, is a gap too.
    const unseen = await rowFor(clean(), ['a1', 'a2', 'a9']);
    expect(unseen.status).toBe('SKIP');
    expect(unseen.reason).toContain('a9');
    // [AX387] Every persisted push is evidence too, even when polling missed it.
    const uncorrelated = clean();
    uncorrelated.offerPushes.push({ attemptId: 'a9', userId: 'u-dr3', createdAt: t(19) });
    const pushGap = await rowFor(uncorrelated);
    expect(pushGap.status).toBe('SKIP');
    expect(pushGap.reason).toMatch(/^INCONCLUSIVE/);
    expect(pushGap.reason).toContain('a9');
    for (const missing of [null, { ...clean(), offers: [] }, { ...clean(), statusLog: [] }, { ...clean(), order: null }]) {
      const absent = await rowFor(missing);
      expect(absent.status, JSON.stringify(missing)).toBe('SKIP');
      expect(absent.reason).toMatch(/^INCONCLUSIVE/);
    }
    expect((await rowFor(clean(), ['a1', 'a2'], false)).status).toBe('SKIP');
    const duplicateWithGap = clean();
    duplicateWithGap.offerPushes.push({ ...duplicateWithGap.offerPushes[0]! });
    duplicateWithGap.offers = [];
    expect((await rowFor(duplicateWithGap)).status).toBe('FAIL');
    const outside = clean(); outside.offerPushes[0]!.userId = 'u-outside';
    expect((await rowFor(outside)).status).toBe('FAIL');
    expect((await rowFor({ ...clean(), order: { ...clean().order, tenantId: 'swift-default' } })).status).toBe('FAIL');
  });
});

describe('[AX370 A1] the crash drill touches only this run’s own jobs — anything else refuses it before setup', () => {
  type Call = { method: string; path: string; who: string };
  const RUN_A1 = 'r-a1';
  const PHONES: Record<string, string> = { '+5920401005': 'C5', '+5920402011': 'R1', '+5920403051': 'DR1', '+5920403052': 'DR2', '+5920403053': 'DR3', '+5920400000': 'admin' };
  const ROSTER_ONLINE = ['DR1', 'DR2', 'DR3'].map((id, i) => ({ id: `r-${id}`, user: { id: `u-${id}`, phone: `+592040305${i + 1}` } }));
  /** The owner's own order, held by roster rider DR2 — never the drill's to touch. */
  const FOREIGN = () => ({ id: 'o-owner', status: 'RIDER_EN_ROUTE_PICKUP', orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', customerId: 'u-owner', vendorId: 'v-owner', customer: { id: 'u-owner' }, vendor: { id: 'v-owner' }, deliveryLat: 6.8, deliveryLng: -58.15 });
  /** A job this run placed (its ledger names it): the plan's customer C5 at the plan's store R1. */
  const OWN = (id = 'o-run') => ({ id, status: 'RIDER_ASSIGNED', orderType: 'FOOD_DELIVERY', paymentMethod: 'CASH', customerId: 'u-C5', vendorId: 'v-R1', customer: { id: 'u-C5' }, vendor: { id: 'v-R1' } });
  const origFetch = globalThis.fetch;
  let dir = '';
  let lines: string[] = [];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crash-a1-')); lines = []; writeFileSync(join(dir, 'crash-drill-scope.json'), JSON.stringify(scope())); });
  afterEach(() => { globalThis.fetch = origFetch; rmSync(dir, { recursive: true, force: true }); });

  /** A stand-in staging API: the roster signs in, the store is ready, riders hold `legs`, `online` are the tenant's online riders. */
  function crashApi(legs: Record<string, any[]>, online: any[], morePages: any[][] = []) {
    const calls: Call[] = [];
    const orders = new Map<string, any>();
    const holder = new Map<string, string>();
    for (const [rider, list] of Object.entries(legs)) for (const l of list) { orders.set(l.id, l); holder.set(l.id, rider); }
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = String(init?.method ?? 'GET');
      const who = String(init?.headers?.authorization ?? '').replace(/^Bearer tok-/, '');
      calls.push({ method, path, who });
      const ok = (data: unknown, extra: object = {}) => ({ status: 200, text: async () => JSON.stringify({ success: true, data, ...extra }) }) as unknown as Response;
      if (path === '/auth/verify-otp') {
        const id = PHONES[JSON.parse(String(init.body)).phone];
        return ok({ user: { id: `u-${id}` }, tokens: { accessToken: `tok-${id}`, expiresIn: 900 } });
      }
      if (path === '/admin/dlq') return ok([]);
      if (path === '/admin/riders') {
        const page = Number(url.searchParams.get('page') ?? 1);
        const pages = [online, ...morePages];
        return ok(pages[page - 1], { meta: { page, hasNext: page < pages.length } });
      }
      if (path === '/vendor/profile') return ok({ vendors: [{ id: 'v-R1', status: 'ACTIVE' }] });
      if (path === '/vendor/vendor/toggle-open') return ok({ isCurrentlyOpen: true });
      if (path === '/vendor/vendor/toggle-orders') return ok({ acceptingOrders: true });
      if (path === '/vendor/items') return ok([{ id: 'i-R1', name: 'R1 Plate', categoryId: 'c-R1', basePrice: 1500, isAvailable: true }]);
      if (path === '/customer/addresses' && method === 'GET') return ok([{ id: 'addr-C5', isDefault: true }]);
      if (path === '/customer/checkout') {
        orders.set('o-new', { id: 'o-new', status: 'PENDING', customerId: 'u-C5', vendorId: 'v-R1' });
        return ok({ orders: [{ id: 'o-new' }] });
      }
      if (path === '/rider/offers/current') return ok(who === 'DR1' && orders.has('o-new') ? { offer: { orderId: 'o-new', offerAttemptId: 'a-new' } } : null);
      if (path === '/rider/orders/active-legs') {
        return ok([...orders.values()].filter((o) => holder.get(o.id) === who && !String(o.status).startsWith('moved:')));
      }
      const leg = path.match(/^\/rider\/orders\/([^/]+)\/([a-z-]+)$/);
      if (leg && method !== 'GET' && orders.has(leg[1]!)) orders.set(leg[1]!, { ...orders.get(leg[1]!), status: `moved:${leg[2]}` });
      return ok({});
    }) as unknown as typeof fetch;
    return { calls, orders };
  }
  /** Every request that could change anything (the roster's own sign-ins aside). */
  const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET' && c.path !== '/auth/verify-otp').map((c) => `${c.method} ${c.path}`);
  const identity = { deploymentId: 'd', environment: 'staging', buildSha: 'b', dataClassification: 'synthetic', testTenant: 't' };
  const scope = () => ({ version: 1, runId: RUN_A1, tenantId: `drill-crash-${createHash('sha256').update(RUN_A1).digest('hex').slice(0, 32)}`, target: { deploymentId: 'd', environment: 'staging', database: 'test' }, admin: { userId: 'u-admin', phone: '+5920400000' }, customer: { userId: 'u-C5', phone: '+5920401005' }, storeOwner: { userId: 'u-R1', phone: '+5920402011' }, riders: ROSTER_ONLINE.map((r) => ({ userId: r.user.id, phone: r.user.phone, riderId: r.id })), store: { vendorId: 'v-R1', itemId: 'i-R1' } });
  const opts = () => ({ runId: RUN_A1, identity, admin: { token: 'tok-admin', userId: 'u-admin' }, adminPhone: '+5920400000', outDir: dir, log: (s: string) => lines.push(s) });
  const ledger = (orders: string[]) => writeFileSync(join(dir, 'crash-drill-orders.json'), JSON.stringify({ runId: RUN_A1, orders }));

  it('[AX387] rejects a shared tenant, another run or deployment, and ambiguous isolated actors', async () => {
    const parser = await import(pathToFileURL(join(process.cwd(), '../../scripts/livetest/crash-scope.ts')).href);
    const valid = scope();
    expect(parser.parseCrashScope(valid, RUN_A1, identity)).toEqual(valid);
    const shared = { ...valid, tenantId: 'swift-default' };
    const anotherRun = { ...valid, runId: 'another-run' };
    const anotherTarget = { ...valid, target: { ...valid.target, deploymentId: 'another-deployment' } };
    const ambiguous = { ...valid, customer: valid.admin };
    for (const invalid of [shared, anotherRun, anotherTarget, ambiguous]) {
      expect(() => parser.parseCrashScope(invalid, RUN_A1, identity)).toThrow(/isolated/);
    }
  });

  it('[AX387] missing lifetime isolation refuses before any request, including sign-in', async () => {
    const api = crashApi({}, ROSTER_ONLINE);
    writeFileSync(join(dir, 'crash-drill-scope.json'), 'null');
    expect(await crash.crashSetup(opts())).toBe(1);
    expect(api.calls).toEqual([]);
    expect(lines.join(' ')).toContain('isolated');
  });

  it('a roster rider holding a job this run cannot prove its own: refused before setup — the job byte-identical, nothing written, the order named', async () => {
    const api = crashApi({ DR2: [FOREIGN()] }, ROSTER_ONLINE);
    const before = JSON.stringify(api.orders.get('o-owner'));
    expect(await crash.crashSetup(opts())).toBe(1);
    expect(JSON.stringify(api.orders.get('o-owner'))).toBe(before);
    expect(writes(api.calls)).toEqual([]);
    expect(lines.join('\n')).toContain('o-owner');
    expect(existsSync(join(dir, 'crash-drill-state.json'))).toBe(false);
  });

  it('C5 at R1 is not proof enough: a job this run’s ledger does not name (another run’s, a journey’s) is refused the same way', async () => {
    ledger(['o-run']);
    const api = crashApi({ DR1: [OWN('o-earlier-run')] }, ROSTER_ONLINE);
    const before = JSON.stringify(api.orders.get('o-earlier-run'));
    expect(await crash.crashSetup(opts())).toBe(1);
    expect(JSON.stringify(api.orders.get('o-earlier-run'))).toBe(before);
    expect(writes(api.calls)).toEqual([]);
    expect(lines.join('\n')).toContain('o-earlier-run');
  });

  it('a rider outside the drill’s three online in the tenant (the order’s candidate pool): refused before any write; an unreadable pool too', async () => {
    const api = crashApi({}, [...ROSTER_ONLINE, { id: 'r-real', user: { id: 'u-real', phone: '+5926001234' } }]);
    expect(await crash.crashSetup(opts())).toBe(1);
    expect(writes(api.calls)).toEqual([]);
    expect(lines.join('\n')).toContain('r-real');
    lines = [];
    const unread = crashApi({}, null as any);
    expect(await crash.crashSetup(opts())).toBe(1);
    expect(writes(unread.calls)).toEqual([]);
  });

  it('[AX387] reads meta.hasNext through all online-rider pages before any setup write', async () => {
    const api = crashApi({}, ROSTER_ONLINE, [[{ id: 'r-next-page', user: { phone: '+5926001234' } }]]);
    expect(await crash.crashSetup(opts())).toBe(1);
    expect(writes(api.calls)).toEqual([]);
    expect(lines.join(' ')).toContain('r-next-page');
    expect(api.calls.filter((c) => c.path === '/admin/riders')).toHaveLength(2);
  });

  it('this run’s own leftover job (in its ledger, C5 at R1) is released; the run then reaches mid-offer and records the order it placed', async () => {
    ledger(['o-run']);
    const api = crashApi({ DR1: [OWN()] }, ROSTER_ONLINE);
    expect(await crash.crashSetup(opts()), lines.join('\n')).toBe(0);
    expect(api.orders.get('o-run').status).toBe('moved:handback');
    expect(JSON.parse(readFileSync(join(dir, 'crash-drill-orders.json'), 'utf8'))).toEqual({ runId: RUN_A1, orders: ['o-run', 'o-new'] });
    expect(JSON.parse(readFileSync(join(dir, 'crash-drill-state.json'), 'utf8'))).toMatchObject({ runId: RUN_A1, orderId: 'o-new' });
  });

  it('the verify phase’s final cleanup releases only this run’s jobs: a foreign job a roster rider holds stays byte-identical, and is named', async () => {
    const past = '2020-01-01T00:00:00.000Z';
    ledger(['o-run', 'o-run-2']);
    writeFileSync(join(dir, 'crash-drill-state.json'), JSON.stringify({ runId: RUN_A1, tenantId: scope().tenantId, setupStartedAt: past, orderId: 'o-run', offer: { moverId: 'DR1', offerAttemptId: 'a1', seenAt: past }, steps: [], negatives: 0 }));
    writeFileSync(join(dir, 'crash-drill-host.json'), JSON.stringify({ worker: 'w', signal: 'SIGKILL', killedAt: past, restartedAt: past, downRightAfterKill: true, downAfterTheWait: true, waitSeconds: 15 }));
    const api = crashApi({ DR1: [OWN()], DR2: [FOREIGN()], DR3: [OWN('o-run-2')] }, ROSTER_ONLINE);
    const before = JSON.stringify(api.orders.get('o-owner'));
    await crash.crashVerify(opts());
    expect(JSON.stringify(api.orders.get('o-owner'))).toBe(before);
    expect(api.calls.filter((c) => c.method !== 'GET' && c.path.includes('o-owner'))).toEqual([]);
    expect(api.orders.get('o-run-2').status).toBe('moved:handback');
    expect(lines.join('\n')).toContain('o-owner');
    // [AX370 A3] The verify record names every attempt a rider was seen holding (here, the setup's own).
    expect(JSON.parse(readFileSync(join(dir, 'crash-drill-verify.json'), 'utf8')).observedAttemptIds).toEqual(['a1']);
  });
});

describe('[AX370 A1] which job is the drill’s: pure', () => {
  const owner = { orders: ['o-run'], customerUserId: 'u-C5', storeVendorId: 'v-R1' };
  const leg = (over: object = {}) => ({ id: 'o-run', status: 'RIDER_ASSIGNED', customerId: 'u-C5', vendorId: 'v-R1', ...over });

  it('only the run’s own order, of the plan’s customer at the plan’s store, is the drill’s', () => {
    expect(crash.isDrillLeg(leg(), owner)).toBe(true);
    expect(crash.isDrillLeg({ orderId: 'o-run', status: 'PICKED_UP', customer: { id: 'u-C5' }, vendor: { id: 'v-R1' } }, owner)).toBe(true);
    expect(crash.isDrillLeg(leg({ id: 'o-other' }), owner)).toBe(false);
    expect(crash.isDrillLeg(leg({ customerId: 'u-owner' }), owner)).toBe(false);
    expect(crash.isDrillLeg(leg({ vendorId: 'v-owner' }), owner)).toBe(false);
    expect(crash.isDrillLeg(leg(), { ...owner, storeVendorId: '' })).toBe(false);
    expect(crash.isDrillLeg(leg({ customerId: '' }), { ...owner, customerUserId: '' })).toBe(false);
  });

  it('the pool is roster-only when every online rider is one of the drill’s; an unreadable list proves nothing', () => {
    const roster = ['+5920403051', '+5920403052', '+5920403053'];
    expect(crash.poolVerdict({ ok: true, riders: [{ id: 'r1', phone: '+5920403051' }] }, roster).ok).toBe(true);
    const mixed = crash.poolVerdict({ ok: true, riders: [{ id: 'r1', phone: '+5920403051' }, { id: 'r-x', phone: '' }] }, roster);
    expect(mixed.ok).toBe(false);
    expect(mixed.detail).toContain('r-x');
    expect(crash.poolVerdict({ ok: false, riders: [], detail: 'the online-rider list could not be read (500)' }, roster).ok).toBe(false);
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
