// PLAT-02 — the worker crash drill, the runner's half [STG-DRILLS D7].
//
// deploy/drill-crash.sh owns the crash (docker kill, 15 s, docker start); the
// runner has no Docker socket by design. Two phases, each a one-shot run of
// this module in the private journeys runner, HTTP only:
//
//   setup   a roster customer places an express cash delivery at R1, R1
//           accepts it (dispatch starts on accept), and the runner waits until
//           a roster rider holds a live offer for it — mid-offer. It records
//           the offer, the dead-letter baseline and its own steps in
//           crash-drill-state.json, and exits; the host kills the worker now.
//   verify  after the restart: within 120 s the offer cascade must have
//           resumed (a fresh offer attempt) or been reconciled (the order
//           assigned); at no moment may two riders hold a live offer for the
//           order; no job may have died in the drill window. The live offer
//           is then accepted and the order walked to the door exactly once.
//           The PLAT-02 row (journeys-result.json format) is written to
//           plat02-crash-drill.json and replaces the run's own PLAT-02 row.
//
// The target is refused exactly as the journeys suite refuses it (guard.ts:
// private address, /test-control identity not production, synthetic data,
// +5920… phones only), before the first write of either phase.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORIGIN, GET, POST, login, type Session } from './client.js';
import { refusePublicTarget, refuseUnsafeIdentity, refuseLivePhones, type TargetIdentity } from './guard.js';
import { JourneyRun, type Journey, type Recorder, type Step } from './journey.js';
import { writeReplacedRow } from './report.js';
import { rosterEntry, type Roster } from './roster.js';
import { ensureFlag, goOnline, goOffline, ping, startHeartbeat, requireAdminPhone } from './provision.js';
import { placeExpress, storeAccepts, storeReadies, riderToDoor, handoverPaid, doorPin, freeRider, mover } from './journeys/dispatch.js';
import { brief, codeOf, customerOrder, sleep, activeLegsOf, TERMINAL } from './journeys/common.js';
import type { Ctx, World } from './journeys/context.js';

const CUSTOMER = 'C5';
const STORE = 'R1';
const RIDERS = ['DR1', 'DR2', 'DR3'];
const STATE = 'crash-drill-state.json';
const HOST = 'crash-drill-host.json';
const ROW = 'plat02-crash-drill.json';
/** The drill's promise: the cascade resumes (or is reconciled) within this long of the restart. */
export const RESUME_WINDOW_MS = 120_000;
const FORGED = 'cl0000000000000000000forged';

export interface CrashState {
  runId: string;
  setupStartedAt: string;
  orderId: string;
  offer: { moverId: string; offerAttemptId: string; seenAt: string };
  dlqBaseline: { count: number; newestFinishedOn: number };
  steps: Step[];
}
export interface CrashHost { worker: string; signal: string; killedAt: string; restartedAt: string; downRightAfterKill: boolean; downAfterTheWait: boolean; waitSeconds: number }

/** One sighting of a live offer for the drill order, by rider. */
export interface Sighting { at: number; moverId: string; offerAttemptId: string }

/**
 * The once-only verdict over every poll: never two riders holding a live offer
 * for the order at one instant, and an attempt, once replaced, never seen
 * again. Pure, so the rule is proven without a staging host.
 */
export function onceOnly(polls: Sighting[][]): { ok: boolean; detail: string } {
  const problems: string[] = [];
  const retired = new Set<string>();
  let current: string | null = null;
  for (const poll of polls) {
    const attempts = [...new Set(poll.map((s) => s.offerAttemptId))];
    const holders = [...new Set(poll.map((s) => s.moverId))];
    if (holders.length > 1) problems.push(`${holders.join(' and ')} held live offers for the order at the same moment`);
    for (const a of attempts) {
      if (retired.has(a)) problems.push(`offer attempt ${a} came back after it was replaced`);
    }
    const now = attempts[0] ?? null;
    if (now && current && now !== current) retired.add(current);
    if (now) current = now;
  }
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${polls.filter((p) => p.length).length} poll(s) with a live offer, one holder at a time` };
}

interface CrashCtx extends Ctx { outDir: string }

async function signIn(id: string): Promise<{ id: string; phone: string; session: Session; lat: number; lng: number; kind?: 'rider' | 'driver'; vendorType?: string }> {
  const e = rosterEntry(id);
  if (!e) throw new Error(`no roster account ${id}`);
  return { ...e, session: await login(e.phone) };
}

/** The accounts this drill needs, signed in (they exist once a journeys run has provisioned the roster). */
async function world(o: { runId: string; identity: TargetIdentity; admin: Session; adminPhone: string; outDir: string; log: (s: string) => void }): Promise<CrashCtx> {
  const customer = await signIn(CUSTOMER);
  const store = await signIn(STORE);
  const riders = await Promise.all(RIDERS.map(signIn));
  const roster: Roster = {
    customers: { [CUSTOMER]: customer },
    vendors: { [STORE]: { ...store, vendorType: store.vendorType ?? 'RESTAURANT' } },
    movers: Object.fromEntries(riders.map((r) => [r.id, { ...r, kind: 'rider' as const }])),
    admin2: null,
  };
  const w: World = { items: {}, liveVendors: [], readyMovers: [], onlineMovers: [], notReady: {}, providers: {} };
  return { runId: o.runId, log: o.log, identity: o.identity, admin: o.admin, adminPhone: o.adminPhone, roster, world: w, stash: { heartbeatOverrides: {} }, drill: null, outDir: o.outDir };
}

async function storeReady(rec: Recorder, ctx: CrashCtx): Promise<void> {
  const s = ctx.roster.vendors[STORE]!;
  const prof = (await GET('/vendor/profile', s.session.token)).json?.data;
  const row = (Array.isArray(prof?.vendors) ? prof.vendors : [prof]).find((v: any) => v?.id) ?? null;
  s.vendorId = row?.id;
  const open = await ensureFlag(s.session.token, '/vendor/vendor/toggle-open', 'isCurrentlyOpen');
  const accepting = await ensureFlag(s.session.token, '/vendor/vendor/toggle-orders', 'acceptingOrders');
  const items = await GET('/vendor/items?limit=50', s.session.token);
  const list: any[] = Array.isArray(items.json?.data) ? items.json.data : items.json?.data?.items ?? [];
  const plate = list.find((i) => i.name === `${STORE} Plate` && i.isAvailable !== false) ?? list.find((i) => i.isAvailable !== false);
  if (plate) ctx.world.items[STORE] = { itemId: plate.id, categoryId: plate.categoryId, price: Number(plate.basePrice), name: plate.name };
  rec.require(`${STORE} is open, accepting and has an item (provisioned by an earlier journeys run)`, row?.status === 'ACTIVE' && open && accepting && !!plate,
    `status=${row?.status} open=${open} accepting=${accepting} item=${plate?.name ?? 'none'}`);
}

/** Riders online at their roster homes. Setup first frees them of leftovers; verify must not touch what they hold. */
async function ridersOnline(rec: Recorder, ctx: CrashCtx, free: boolean): Promise<void> {
  for (const id of RIDERS) {
    const m = mover(ctx, id);
    const left = free ? await freeRider(ctx, id) : [];
    const on = await goOnline(m);
    if (on.ok || codeOf(on) === 'ALREADY_ONLINE') {
      await ping(m);
      ctx.world.onlineMovers.push(id);
      ctx.world.readyMovers.push(id);
    }
    if (left.length) ctx.log(`    ${id} still holds ${left.join('; ')}`);
  }
  rec.require('roster riders are online near the store', ctx.world.onlineMovers.length > 0, `online: ${ctx.world.onlineMovers.join(' ') || 'none'}`);
}

async function dlq(admin: Session): Promise<{ ok: boolean; rows: any[] }> {
  const r = await GET('/admin/dlq', admin.token);
  return { ok: r.ok, rows: Array.isArray(r.json?.data) ? r.json.data : [] };
}

/** Every rider's live offer for the order, right now. */
async function sightings(ctx: CrashCtx, orderId: string): Promise<Sighting[]> {
  const out: Sighting[] = [];
  for (const id of RIDERS) {
    const m = mover(ctx, id);
    const r = await GET('/rider/offers/current', m.session.token);
    const offer = r.json?.data?.offer ?? null;
    if (offer?.orderId === orderId) out.push({ at: Date.now(), moverId: id, offerAttemptId: String(offer.offerAttemptId) });
  }
  return out;
}

/** The roster rider whose active legs include the order, if any. */
async function holderOf(ctx: CrashCtx, orderId: string): Promise<string | null> {
  for (const id of RIDERS) {
    const legs = activeLegsOf((await GET('/rider/orders/active-legs', mover(ctx, id).session.token)).json);
    if (legs.some((l) => (l.id ?? l.orderId) === orderId)) return id;
  }
  return null;
}

/** Phase 1: reach mid-offer, record it, exit. */
export async function crashSetup(o: { runId: string; identity: TargetIdentity; admin: Session; adminPhone: string; outDir: string; log: (s: string) => void }): Promise<number> {
  const ctx = await world(o);
  const run = new JourneyRun<CrashCtx>({ id: 'PLAT-02', title: 'setup', cases: '', run: async () => undefined });
  const rec = run.rec;
  const setupStartedAt = new Date().toISOString();
  let stop = () => {};
  try {
    await storeReady(rec, ctx);
    await ridersOnline(rec, ctx, true);
    stop = startHeartbeat(ctx.roster, ctx.world, {});
    const base = await dlq(ctx.admin);
    rec.check('the dead-letter queues are readable before the crash', base.ok, `${base.rows.length} failed job(s) listed`);
    const placed = await placeExpress(ctx, CUSTOMER, STORE, STORE, `crash-${o.runId}`);
    rec.require('an express cash delivery (no hold)', !!placed.id, brief(placed.res));
    rec.expect('the store accepts it (dispatch starts on accept)', await storeAccepts(ctx, STORE, placed.id!), 200);
    let got: Sighting[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && got.length === 0) {
      got = await sightings(ctx, placed.id!);
      if (!got.length) await sleep(1_000);
    }
    rec.require('mid-offer: a rider holds a live offer for the order', got.length === 1, got.length ? `${got[0]!.moverId} holds ${got[0]!.offerAttemptId}` : 'no offer within 60 s');
    const state: CrashState = {
      runId: o.runId,
      setupStartedAt,
      orderId: placed.id!,
      offer: { moverId: got[0]!.moverId, offerAttemptId: got[0]!.offerAttemptId, seenAt: new Date(got[0]!.at).toISOString() },
      dlqBaseline: { count: base.rows.length, newestFinishedOn: Math.max(0, ...base.rows.map((r) => Number(r.finishedOn ?? 0))) },
      steps: [...rec.steps],
    };
    writeFileSync(join(o.outDir, STATE), JSON.stringify(state, null, 2) + '\n');
    o.log(`  mid-offer: order ${state.orderId} offered to ${state.offer.moverId} (${state.offer.offerAttemptId}); the host kills the worker now`);
    return 0;
  } catch (e: any) {
    o.log(`  setup did not reach mid-offer: ${e?.message ?? e}`);
    for (const s of rec.steps) if (!s.ok) o.log(`    ✗ ${s.name} — ${s.detail.slice(0, 240)}`);
    return 1;
  } finally {
    stop();
  }
}

/** Phase 3: after the restart — resumed, once-only, one completion; write the PLAT-02 row. */
export async function crashVerify(o: { runId: string; identity: TargetIdentity; admin: Session; adminPhone: string; outDir: string; log: (s: string) => void }): Promise<number> {
  const statePath = join(o.outDir, STATE);
  if (!existsSync(statePath)) throw new Error(`${STATE} is missing in ${o.outDir}: run the setup phase first (deploy/drill-crash.sh does)`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as CrashState;
  const host = existsSync(join(o.outDir, HOST)) ? JSON.parse(readFileSync(join(o.outDir, HOST), 'utf8')) as CrashHost : null;
  const ctx = await world(o);
  const journey: Journey<CrashCtx> = {
    id: 'PLAT-02',
    title: 'Worker restart / job recovery mid-flow',
    cases: 'worker crash mid-offer/hold; DLQ; retry; once-only completion',
    run: (rec, c) => verifyRun(rec, c, state, host),
  };
  const run = new JourneyRun(journey);
  run.rec.steps.push(...state.steps.map((s) => ({ ...s, name: `setup: ${s.name}` })));
  await run.run(ctx);
  const target = { deploymentId: o.identity.deploymentId, environment: o.identity.environment, buildSha: o.identity.buildSha };
  const row = run.result(target, o.runId);
  const written = writeReplacedRow(o.outDir, ROW, row, {
    runId: o.runId,
    baseUrl: ORIGIN,
    target: { ...target, dataClassification: o.identity.dataClassification, testTenant: o.identity.testTenant },
  });
  o.log(`  PLAT-02 ${row.status}${row.reason ? ` — ${row.reason.slice(0, 200)}` : ''}`);
  for (const s of row.steps) if (!s.ok) o.log(`    ✗ ${s.name} — ${s.detail.slice(0, 240)}`);
  o.log(`  ${written.row}${written.merged ? `\n  ${written.merged} (PLAT-02 row replaced)` : ''}`);
  return row.status === 'FAIL' ? 1 : 0;
}

async function verifyRun(rec: Recorder, ctx: CrashCtx, state: CrashState, host: CrashHost | null): Promise<void> {
  rec.check('the host killed the worker mid-offer (SIGKILL, no drain) and started it again after the wait',
    !!host && host.signal === 'SIGKILL' && host.downRightAfterKill,
    host ? `${host.worker}: killed ${host.killedAt}, down=${host.downRightAfterKill}, still down after ${host.waitSeconds}s=${host.downAfterTheWait}, started ${host.restartedAt}` : `${HOST} missing: the host step did not record the crash`);
  const restartedAt = host ? Date.parse(host.restartedAt) : Date.now();
  let stop = () => {};
  try {
    await ridersOnline(rec, ctx, false);
    stop = startHeartbeat(ctx.roster, ctx.world, {});
    const C = ctx.roster.customers[CUSTOMER]!.session;

    // 1. Resumed or reconciled, within the window.
    const polls: Sighting[][] = [[{ at: Date.parse(state.offer.seenAt), moverId: state.offer.moverId, offerAttemptId: state.offer.offerAttemptId }]];
    let live: Sighting | null = null;
    let assigned = false;
    const deadline = restartedAt + RESUME_WINDOW_MS;
    while (Date.now() < deadline) {
      const now = await sightings(ctx, state.orderId);
      polls.push(now);
      const fresh = now.find((s) => s.offerAttemptId !== state.offer.offerAttemptId);
      const order = await customerOrder(C, state.orderId);
      if (order?.riderId || ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP'].includes(order?.status)) { assigned = true; break; }
      if (fresh) { live = fresh; break; }
      if (order && TERMINAL.includes(order.status)) break;
      await sleep(2_000);
    }
    const tookMs = Date.now() - restartedAt;
    rec.check(`the offer cascade resumed within ${RESUME_WINDOW_MS / 1000} s of the restart (a fresh offer attempt, or the order assigned)`, !!live || assigned,
      live ? `${live.moverId} holds fresh attempt ${live.offerAttemptId} ${Math.round(tookMs / 1000)} s after the restart (before the crash: ${state.offer.moverId}/${state.offer.offerAttemptId})`
        : assigned ? `the order was assigned ${Math.round(tookMs / 1000)} s after the restart` : `no fresh offer and no assignment within ${RESUME_WINDOW_MS / 1000} s`);
    const once = onceOnly(polls);
    rec.check('nothing ran twice: never two live offers for the order at once, and no replaced attempt came back', once.ok, once.detail);

    // 2. One completion: the live offer is taken and the order walked to the door.
    if (live) {
      const m = mover(ctx, live.moverId);
      rec.expect('the rider takes the resumed offer', await POST('/rider/offers/accept', { orderId: state.orderId, offerAttemptId: live.offerAttemptId }, m.session.token), 200);
    }
    const holder = await holderOf(ctx, state.orderId);
    rec.check('exactly one rider holds the order', !!holder, holder ? `${holder}` : 'no roster rider holds it');
    if (holder) {
      const m = mover(ctx, holder);
      await storeReadies(ctx, STORE, state.orderId);
      const walked = await riderToDoor(m.session, state.orderId);
      rec.expect('the rider carries it to the door', walked, 200);
      const handed = await handoverPaid(m.session, state.orderId, { lat: ctx.roster.customers[CUSTOMER]!.lat, lng: ctx.roster.customers[CUSTOMER]!.lng }, await doorPin(C, state.orderId));
      rec.expect('the cash is handed over at the door', handed, [200, 201]);
    }
    const detail = await GET(`/admin/orders/${state.orderId}`, ctx.admin.token);
    const history: any[] = Array.isArray(detail.json?.data?.statusHistory) ? detail.json.data.statusHistory : [];
    const count = (s: string) => history.filter((h) => h.status === s).length;
    const final = detail.json?.data?.status;
    rec.check('the order ends in a sane state, completed exactly once', detail.ok && ['DELIVERED', 'COMPLETED'].includes(final) && count('DELIVERED') === 1 && count('RIDER_ASSIGNED') <= 1,
      `status=${final} · DELIVERED logged ${count('DELIVERED')}× · RIDER_ASSIGNED logged ${count('RIDER_ASSIGNED')}× · ${history.length} status rows`);

    // 3. The dead-letter page: nothing died in the drill window.
    const after = await dlq(ctx.admin);
    const since = Date.parse(state.setupStartedAt);
    const fresh = after.rows.filter((r) => Number(r.finishedOn ?? 0) >= since || String(r.data ?? '').includes(state.orderId));
    rec.check('the dead-letter page is clean: no job failed for good in the drill window', after.ok && fresh.length === 0,
      after.ok ? `${fresh.length} new dead letter(s)${fresh.length ? `: ${fresh.slice(0, 5).map((r) => `${r.queue}/${r.name} ${String(r.failedReason ?? '').slice(0, 80)}`).join('; ')}` : ''} · ${after.rows.length} listed in total (baseline ${state.dlqBaseline.count})` : 'unreadable');
    rec.check('every listed dead letter states its recovery class', after.rows.every((r) => r.recovery != null), `${after.rows.length} row(s)`);
    rec.deny('a non-founder cannot read the DLQ', await GET('/admin/dlq', C.token), [403]);
    rec.deny('requeue of a job that does not exist', await POST(`/admin/dlq/dispatch/${FORGED}/requeue`, {}, ctx.admin.token), [400, 404]);
  } finally {
    stop();
    for (const id of RIDERS) {
      await freeRider(ctx, id).catch(() => []);
      await goOffline(mover(ctx, id)).catch(() => undefined);
    }
  }
}

/** Entry for run.ts --suite=crash-drill --phase=setup|verify: the same refusals as the journeys suite, then the phase. */
export async function crashDrill(phase: string | undefined, log: (s: string) => void): Promise<number> {
  if (phase !== 'setup' && phase !== 'verify') throw new Error('--phase=setup|verify is required');
  const runId = process.env.LIVETEST_RUN_ID || '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) throw new Error('LIVETEST_RUN_ID must name the journeys run the PLAT-02 row belongs to');
  const outDir = process.env.LIVETEST_OUT_DIR || '';
  if (!outDir) throw new Error('LIVETEST_OUT_DIR is required (deploy/drill-crash.sh mounts the run results at /results)');
  const phones = [CUSTOMER, STORE, ...RIDERS].map((id) => rosterEntry(id)?.phone ?? '');
  const adminPhone = requireAdminPhone(process.env.LIVETEST_ADMIN_PHONE);
  refuseLivePhones([...phones, adminPhone]);
  await refusePublicTarget(ORIGIN);
  let admin: Session | null = null;
  const identity = await refuseUnsafeIdentity(
    { get: async (p, token) => { const r = await GET(p, token); return { status: r.status, json: r.json }; } },
    async () => { admin = await login(adminPhone); return admin.token; },
  );
  log(`\nPLAT-02 crash drill (${phase}) → ${ORIGIN} · deployment ${identity.deploymentId} · run ${runId}\n`);
  const o = { runId, identity, admin: admin!, adminPhone, outDir, log };
  return phase === 'setup' ? crashSetup(o) : crashVerify(o);
}
