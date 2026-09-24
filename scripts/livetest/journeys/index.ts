// The pilot journey suite [TASK-057]: every one of the 42 ledger journeys,
// driven over real HTTP against the private journeys instance.
//
// Order of play:
//   1. roster  — the sanctioned accounts through the real signup path (reused
//                on re-runs), movers cleared and online, vendors orderable;
//   2. prepare — journeys that need a store to SEE an order place it now, so
//                the 5-minute LIFECYCLE_V2 hold runs down once for all of them;
//   3. fill    — journeys that need no released order run while the hold runs
//                down (only those expected to end inside the auto-reject window);
//   4. release — right after the hold, stores accept and riders claim the
//                prepared orders (a store must answer within 5 minutes);
//   5. run     — the order-driven journeys, the rest, then the OTP-abuse pair
//                (each waits out the per-IP OTP bucket) last;
//   6. finish  — checks that need wall-clock time (an expiry);
//   7. cleanup — movers offline; results written.

import type { Session } from '../client.js';
import type { TargetIdentity } from '../guard.js';
import { JourneyRun, type Journey, type JourneyResult } from '../journey.js';
import { writeResults } from '../report.js';
import { seedJourneyRoster } from '../roster.js';
import { provisionJourneyWorld, moversOffline, startHeartbeat } from '../provision.js';
import { sleep } from '../client.js';
import { latestHoldUntil } from './common.js';
import type { Ctx } from './context.js';
import { AUTH_01, AUTH_02, AUTH_03, PLAT_03 } from './auth.js';
import { CUST_01, CUST_02, CUST_03, CUST_04, CUST_05, AUTH_04 } from './customer.js';
import { VENDOR_JOURNEYS } from './vendor.js';
import { MOVER_JOURNEYS } from './mover.js';
import { TAXI_JOURNEYS } from './taxi.js';
import { COURIER_JOURNEYS } from './courier.js';
import { SERVICE_JOURNEYS } from './services.js';
import { MONEY_JOURNEYS } from './money.js';
import { SAFETY_JOURNEYS } from './safety.js';
import { NOTIFICATION_JOURNEYS } from './notifications.js';
import { ADMIN_JOURNEYS } from './admin.js';
import { PLATFORM_JOURNEYS } from './platform.js';

/** Every journey, keyed by ledger id. */
export const ALL: Journey<Ctx>[] = [
  AUTH_01, AUTH_02, AUTH_03, AUTH_04,
  CUST_01, CUST_02, CUST_03, CUST_04, CUST_05,
  ...VENDOR_JOURNEYS,
  ...MOVER_JOURNEYS,
  ...TAXI_JOURNEYS,
  ...COURIER_JOURNEYS,
  ...SERVICE_JOURNEYS,
  ...MONEY_JOURNEYS,
  ...SAFETY_JOURNEYS,
  ...NOTIFICATION_JOURNEYS,
  ...ADMIN_JOURNEYS,
  ...PLATFORM_JOURNEYS,
  PLAT_03,
];

/** Ledger order for the report (the ledger's own journey order). */
export const LEDGER_ORDER = [
  'AUTH-01', 'AUTH-02', 'AUTH-03', 'AUTH-04',
  'CUST-01', 'CUST-02', 'CUST-03', 'CUST-04', 'CUST-05',
  'VEND-01', 'VEND-02', 'VEND-03', 'VEND-04', 'VEND-05',
  'RIDE-01', 'RIDE-02', 'RIDE-03', 'RIDE-04',
  'TAXI-01', 'TAXI-02', 'TAXI-03', 'TAXI-04', 'TAXI-05',
  'COUR-01', 'COUR-02',
  'SERV-01', 'SERV-02',
  'MONEY-01', 'MONEY-02', 'MONEY-03',
  'SAFE-01', 'SAFE-02',
  'NOTIF-01', 'NOTIF-02',
  'ADMIN-01', 'ADMIN-02', 'ADMIN-03', 'ADMIN-04', 'ADMIN-05',
  'PLAT-01', 'PLAT-02', 'PLAT-03',
];

/** Run last: each waits out the shared per-IP OTP bucket first. */
const LAST = ['AUTH-01', 'PLAT-03'];

export interface SuiteOpts {
  runId: string;
  outDir: string;
  identity: TargetIdentity;
  admin: Session;
  adminPhone: string;
  only?: string;
  log: (s: string) => void;
}

export async function runJourneySuite(o: SuiteOpts): Promise<number> {
  const startedAt = new Date().toISOString();
  const target = { deploymentId: o.identity.deploymentId, environment: o.identity.environment, buildSha: o.identity.buildSha };
  const wanted = o.only ? new Set(o.only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const byId = new Map(ALL.map((j) => [j.id, j]));
  const missing = LEDGER_ORDER.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`journeys missing from the suite: ${missing.join(', ')}`);
  const selected = LEDGER_ORDER.filter((id) => !wanted || wanted.has(id)).map((id) => byId.get(id)!);

  o.log('Phase 1 — roster (real signup path) and world (vendors orderable, movers online)');
  const roster = await seedJourneyRoster(o.log);
  const world = await provisionJourneyWorld(roster, o.admin, o.log);
  const overrides: Record<string, { lat: number; lng: number } | null | undefined> = {};
  const ctx: Ctx = { runId: o.runId, log: o.log, identity: o.identity, admin: o.admin, adminPhone: o.adminPhone, roster, world, stash: { heartbeatOverrides: overrides } };
  const stopHeartbeat = startHeartbeat(roster, world, overrides as Record<string, { lat: number; lng: number } | null>);

  const runs = new Map(selected.map((j) => [j.id, new JourneyRun<Ctx>(j)]));
  const done = new Set<string>();
  const runOne = async (j: Journey<Ctx>) => {
    const t0 = Date.now();
    await runs.get(j.id)!.run(ctx);
    done.add(j.id);
    const r = runs.get(j.id)!.result(target, o.runId);
    o.log(`  ${r.status.padEnd(4)} ${j.id} ${j.title} (${Math.round((Date.now() - t0) / 1000)}s)`);
    // The evidence, as it happens: a failed step is visible in the log before the run ends.
    for (const s of r.steps) if (!s.ok) o.log(`       ✗ ${s.name} — ${s.detail.slice(0, 300)}`);
    if (r.status === 'SKIP' && r.reason) o.log(`       ○ ${r.reason.slice(0, 300)}`);
  };

  try {
    o.log('\nPhase 2 — prepare (orders that must clear the hold)');
    for (const r of runs.values()) {
      if (!r.journey.prepare) continue;
      o.log(`  prepare ${r.journey.id}`);
      await r.prepare(ctx);
    }
    const releaseAt = latestHoldUntil;

    o.log('\nPhase 3 — journeys that need no released order, while the hold runs down');
    const independent = selected.filter((j) => !j.prepare && !j.release && !LAST.includes(j.id));
    for (const j of independent) {
      // A store must accept a prepared order within 5 minutes of its release (auto-reject):
      // start a journey here only if it should end by then.
      if (releaseAt && Date.now() + (j.estimateSeconds ?? 60) * 1000 > releaseAt + 120_000) continue;
      await runOne(j);
    }
    if (releaseAt > Date.now()) {
      o.log(`  waiting ${Math.round((releaseAt - Date.now()) / 1000)}s for the hold to end`);
      await sleep(releaseAt - Date.now() + 1_500);
    }

    o.log('\nPhase 4 — release: stores and riders claim the prepared orders');
    const prepared = selected.filter((j) => j.prepare || j.release);
    const courierFirst = [...prepared].sort((a, b) => Number(b.id.startsWith('COUR')) - Number(a.id.startsWith('COUR')));
    for (const j of courierFirst) {
      if (!j.release) continue;
      o.log(`  release ${j.id}`);
      await runs.get(j.id)!.release(ctx);
    }

    o.log('\nPhase 5 — the order-driven journeys, then the rest');
    for (const j of courierFirst) await runOne(j);
    for (const j of independent) if (!done.has(j.id)) await runOne(j);
    for (const j of selected.filter((x) => LAST.includes(x.id))) await runOne(j);

    o.log('\nPhase 6 — checks that need time to pass');
    for (const j of selected) if (j.finish) await runs.get(j.id)!.finish(ctx);
  } finally {
    stopHeartbeat();
    o.log('\nPhase 7 — cleanup');
    await moversOffline(roster, world, o.log);
  }

  const results: JourneyResult[] = selected.map((j) => runs.get(j.id)!.result(target, o.runId));
  const meta = {
    runId: o.runId,
    baseUrl: process.env.LIVETEST_BASE_URL || 'http://localhost:3000',
    target: { ...target, dataClassification: o.identity.dataClassification, testTenant: o.identity.testTenant },
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  const files = writeResults(o.outDir, meta, results);
  const count = (s: string) => results.filter((r) => r.status === s).length;
  o.log('\n──────────────────────────────────────────');
  for (const r of results) {
    const extra = r.status === 'PASS' && r.skippedCases.length ? ` (${r.skippedCases.length} device-gate case(s) left)` : r.reason ? ` — ${r.reason.slice(0, 160)}` : '';
    o.log(`  ${r.status.padEnd(4)} ${r.journeyId} ${r.title}${extra}`);
  }
  o.log('──────────────────────────────────────────');
  o.log(`  ${count('PASS')} PASS · ${count('FAIL')} FAIL · ${count('SKIP')} SKIP of ${results.length}`);
  o.log(`  ${files.json}\n  ${files.md}\n`);
  return count('FAIL') > 0 ? 1 : 0;
}
