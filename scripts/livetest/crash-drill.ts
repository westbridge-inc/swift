// PLAT-02 — the worker crash drill, the runner's half [STG-DRILLS D7].
//
// deploy/drill-crash.sh owns the crash (the in-worker guard, docker kill, 15 s,
// docker start) and the durable evidence read; the runner has no Docker socket
// and no database by design. Three phases, each a one-shot run of this module
// in the private journeys runner, HTTP only:
//
//   setup     the dead-letter page must be valid and EMPTY [AX324 R8] — a
//             drill that could never PASS kills nothing. Then, still before
//             its first write [AX370 A1]: every job the roster riders hold
//             must be PROVEN this run's own (an order in this run's ledger,
//             crash-drill-orders.json, placed by C5 at R1) — any other job
//             refuses the drill, named, with nothing touched — and no rider
//             but the run riders may be online in the tenant. The host first
//             mints a protected per-run CRAWLER tenant with six synthetic
//             actors; public signup and partner activation cannot join it.
//             This tenant boundary survives setup failure, restart and handback.
//             The online list is an additional sanity check. Only then are
//             the run's own leftovers released, a roster customer places an
//             express cash delivery at R1 (recorded in the ledger at once), R1
//             accepts it (dispatch starts on accept), and the runner waits
//             until a roster rider holds a live offer for it — mid-offer. It
//             records the offer and its own steps in crash-drill-state.json,
//             and exits; the host kills the worker now.
//   verify    after the restart: within 120 s the offer cascade must have
//             resumed (a fresh offer attempt) or been reconciled (the order
//             assigned). The live offer is accepted and the order walked to
//             the door exactly once. EVERY rider's live offers and legs are
//             watched the whole way, through completion and a tail after it
//             [AX324 R7]: never two live offers at once, no replaced attempt
//             back, no live offer once assigned, and exactly one rider ever
//             holding the order. The record goes to crash-drill-verify.json,
//             with every attempt a rider saw. The final cleanup releases only
//             this run's own jobs; anything else a rider holds is named and
//             left exactly as it is [AX370 A1].
//   finalize  the host has read the order's durable rows inside the worker
//             (crash-drill-evidence.json: offer publications, offer pushes,
//             the dispatch journal, the status log). They are judged here
//             (durableOnceOnly) — what ran twice between two polls leaves rows
//             — together with the verify record; the PLAT-02 row
//             (journeys-result.json format) is written to plat02-crash-drill.json
//             and replaces the run's own PLAT-02 row. No durable evidence, no PASS;
//             INCOMPLETE evidence (the accepted attempt or an attempt a rider
//             saw has no publication record, no search, no assignment) is
//             INCONCLUSIVE — the row says so and is never a PASS [AX370 A3].
//
// The target is refused exactly as the journeys suite refuses it (guard.ts:
// private address, /test-control identity not production — and pinned by the
// host to the identity the worker's own guard judged — synthetic data, +5920…
// phones only), before the first write of every phase.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORIGIN, GET, POST, login, type Session } from './client.js';
import { refusePublicTarget, refuseUnsafeIdentity, refuseLivePhones, type TargetIdentity } from './guard.js';
import { JourneyRun, type Journey, type Recorder, type Step } from './journey.js';
import { writeReplacedRow } from './report.js';
import { crashTenantId, parseCrashScope, type CrashScope } from './crash-scope.js';
import { rosterEntry, type Roster } from './roster.js';
import { ensureFlag, goOnline, goOffline, ping, startHeartbeat, requireAdminPhone } from './provision.js';
import { placeExpress, storeAccepts, storeReadies, riderToDoor, handoverPaid, doorPin, releaseLeg, mover } from './journeys/dispatch.js';
import { brief, codeOf, customerOrder, sleep, activeLegsOf, TERMINAL } from './journeys/common.js';
import type { Ctx, World } from './journeys/context.js';

const CUSTOMER = 'C5';
const STORE = 'R1';
const RIDERS = ['DR1', 'DR2', 'DR3'];
const STATE = 'crash-drill-state.json';
const HOST = 'crash-drill-host.json';
const VERIFY = 'crash-drill-verify.json';
const EVIDENCE = 'crash-drill-evidence.json';
const ROW = 'plat02-crash-drill.json';
/** [AX370 A1] Every order this run placed, written the moment checkout answers: the run's provenance. */
const LEDGER = 'crash-drill-orders.json';
/** The drill's promise: the cascade resumes (or is reconciled) within this long of the restart. */
export const RESUME_WINDOW_MS = 120_000;
/** Observation continues this many polls (2 s apart) after the order is delivered. */
const TAIL_POLLS = 3;
const FORGED = 'cl0000000000000000000forged';

export interface CrashState {
  runId: string;
  setupStartedAt: string;
  tenantId: string;
  riderUsers: string[];
  orderId: string;
  offer: { moverId: string; offerAttemptId: string; seenAt: string };
  steps: Step[];
  negatives: number;
}
export interface CrashHost { worker: string; signal: string; killedAt: string; restartedAt: string; downRightAfterKill: boolean; downAfterTheWait: boolean; waitSeconds: number }

/** One sighting of a live offer for the drill order, by rider. */
export interface Sighting { at: number; moverId: string; offerAttemptId: string }

/** What the verify phase saw and did, for the finalize phase to judge with the durable rows. */
export interface CrashVerify {
  runId: string;
  orderId: string;
  steps: Step[];
  negatives: number;
  /** The attempt the drill's rider accepted after the restart (null: reconciled without one). */
  acceptedAttemptId: string | null;
  /** [AX370 A3] Every offer attempt a rider was seen holding, before and after the assignment. */
  observedAttemptIds: string[];
  finishedAt: string;
}

/** The server's durable rows for the drill order (apps/api/src/modules/ops/drills/evidence.ts). */
export interface CrashEvidence {
  version: 1;
  orderId: string;
  readAt: string;
  order: { tenantId?: string; status: string; riderId: string | null } | null;
  offers: Array<{ attemptId: string | null; recipientId: string; sentAt: string; acknowledgedAt: string | null }>;
  offerPushes: Array<{ attemptId: string | null; userId: string; createdAt: string }>;
  searches: Array<{ id: string; status: string; wave: number; startedAt: string; assignedAt: string | null; assignedTo: string | null; deliveryAuthorityVersion: number | null }>;
  statusLog: Array<{ status: string; createdAt: string }>;
}

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

/** [AX324 R7] Once the order is assigned, no rider may see a live offer for it — through completion. */
export function noOfferAfterAssignment(polls: Sighting[][]): { ok: boolean; detail: string } {
  const seen = polls.flat();
  return seen.length === 0
    ? { ok: true, detail: `${polls.length} poll(s) after the assignment, through completion: no live offer` }
    : { ok: false, detail: `a live offer for the assigned order: ${seen.map((s) => `${s.moverId}/${s.offerAttemptId}`).join('; ')}` };
}

/**
 * [AX324 R7] Every holder, every poll: never two riders holding the order's
 * leg at once, and exactly one rider ever holding it across the whole window.
 */
export function holdersVerdict(polls: string[][]): { ok: boolean; detail: string } {
  const problems: string[] = [];
  for (const poll of polls) {
    const at = [...new Set(poll)];
    if (at.length > 1) problems.push(`${at.join(' and ')} held the order at the same moment`);
  }
  const ever = [...new Set(polls.flat())];
  if (ever.length === 0) problems.push('no roster rider was ever seen holding the order');
  if (ever.length > 1) problems.push(`the order passed through ${ever.length} riders (${ever.join(', ')}); it was handed out more than once`);
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${polls.length} poll(s) of every rider's legs: only ${ever[0]} ever held it` };
}

/** [AX324 R8] A PASS needs a VALID, EMPTY dead-letter page — nothing filtered away. */
export function dlqVerdict(r: { ok: boolean; json: any }): { ok: boolean; count: number | null; detail: string } {
  const rows = r.json?.data;
  if (!r.ok || r.json?.success !== true || !Array.isArray(rows)) {
    return { ok: false, count: null, detail: `not a valid dead-letter page (ok=${r.ok}, data is ${Array.isArray(rows) ? 'a list' : typeof rows})` };
  }
  if (rows.length > 0) {
    return { ok: false, count: rows.length, detail: `${rows.length} dead letter(s): ${rows.slice(0, 5).map((x: any) => `${x.queue}/${x.name} ${String(x.failedReason ?? '').slice(0, 80)}`).join('; ')}` };
  }
  return { ok: true, count: 0, detail: 'valid and empty' };
}

const countBy = <T>(xs: T[], key: (x: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
};
const twice = (m: Map<string, number>): string[] => [...m.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);

/** One durable rule's outcome. `inconclusive`: the rows needed to judge are MISSING — never a PASS, never a found duplicate. */
export interface DurableCheck { name: string; ok: boolean; detail: string; inconclusive?: boolean }

/**
 * [AX324 R7] The durable once-only verdict: what the server WROTE about the
 * order across the whole crash window. A job that ran twice between two live
 * polls still leaves a second row. Pure, so each rule is proven without a host.
 *
 * [AX370 A3] Absent rows prove nothing: publication is recorded AFTER the
 * socket emit, and a failed write is swallowed (dispatch.service.ts). So the
 * evidence must be COMPLETE — the accepted attempt and every attempt a rider
 * was seen holding each have a publication record, and the dispatch journal
 * holds the order's search with exactly one assignment (the rule below still
 * FAILS a second one). A gap is INCONCLUSIVE.
 */
export function durableOnceOnly(e: CrashEvidence, acceptedAttemptId: string | null, observedAttemptIds: string[] = []): DurableCheck[] {
  const out: DurableCheck[] = [];
  const statuses = countBy(e.statusLog, (l) => l.status);
  const assignedAt = e.statusLog.find((l) => l.status === 'RIDER_ASSIGNED')?.createdAt ?? null;

  const unattributed = e.offers.filter((o) => !o.attemptId).length;
  const published = twice(countBy(e.offers.filter((o) => o.attemptId), (o) => o.attemptId!));
  out.push({
    name: 'durable: every offer attempt was published once (alert deliveries)',
    ok: e.offers.length > 0 && published.length === 0 && unattributed === 0,
    ...(published.length === 0 && (e.offers.length === 0 || unattributed > 0) ? { inconclusive: true } : {}),
    detail: `${e.offers.length} publication(s) of ${new Set(e.offers.map((o) => o.attemptId)).size} attempt(s)${published.length ? `; published twice: ${published.join(', ')}` : ''}${unattributed ? `; ${unattributed} without an attempt id (cannot be proven once)` : ''}`,
  });

  const late = assignedAt ? e.offers.filter((o) => o.attemptId !== acceptedAttemptId && Date.parse(o.sentAt) > Date.parse(assignedAt)) : [];
  out.push({
    name: 'durable: no new offer was published after the order was assigned',
    ok: !!assignedAt && late.length === 0,
    ...(!assignedAt ? { inconclusive: true } : {}),
    detail: assignedAt ? (late.length ? `published after ${assignedAt}: ${late.map((o) => `${o.attemptId}@${o.sentAt}`).join('; ')}` : `none after ${assignedAt}`) : 'the order was never assigned',
  });

  const pushedTwice = twice(countBy(e.offerPushes.filter((p) => p.attemptId), (p) => p.attemptId!));
  const pushUnattributed = e.offerPushes.filter((p) => !p.attemptId).length;
  out.push({
    name: 'durable: every offer attempt was pushed at most once (dispatch_offer notifications)',
    ok: pushedTwice.length === 0 && pushUnattributed === 0,
    ...(pushedTwice.length === 0 && pushUnattributed > 0 ? { inconclusive: true } : {}),
    detail: `${e.offerPushes.length} offer push(es)${pushedTwice.length ? `; pushed twice: ${pushedTwice.join(', ')}` : ''}${pushUnattributed ? `; ${pushUnattributed} without an attempt id` : ''}`,
  });

  const loggedTwice = twice(statuses);
  out.push({
    name: 'durable: every order status was logged once — one assignment, one delivery',
    ok: loggedTwice.length === 0 && statuses.get('RIDER_ASSIGNED') === 1 && statuses.get('DELIVERED') === 1,
    ...(loggedTwice.length === 0 && (!statuses.has('RIDER_ASSIGNED') || !statuses.has('DELIVERED')) ? { inconclusive: true } : {}),
    detail: `${e.statusLog.map((l) => l.status).join(' → ')}${loggedTwice.length ? `; logged twice: ${loggedTwice.join(', ')}` : ''}`,
  });

  const assignedSearches = e.searches.filter((s) => s.status === 'ASSIGNED');
  out.push({
    name: 'durable: the dispatch journal assigned the order at most once',
    ok: assignedSearches.length <= 1,
    detail: `${e.searches.length} search(es): ${e.searches.map((s) => `${s.status}${s.assignedTo ? `→${s.assignedTo}` : ''}`).join(', ') || 'none'}`,
  });

  out.push({
    name: 'durable: the order ends delivered, with its one rider',
    ok: !!e.order && ['DELIVERED', 'COMPLETED'].includes(e.order.status) && !!e.order.riderId,
    ...(!e.order ? { inconclusive: true } : {}),
    detail: e.order ? `status=${e.order.status} rider=${e.order.riderId ?? 'none'}` : 'the order is missing',
  });

  const recorded = new Set(e.offers.map((o) => o.attemptId).filter((a): a is string => !!a));
  const gaps: string[] = [];
  if (acceptedAttemptId && !recorded.has(acceptedAttemptId)) gaps.push(`the accepted attempt ${acceptedAttemptId} has no publication record`);
  const unrecorded = [...new Set(observedAttemptIds)].filter((a) => a !== acceptedAttemptId && !recorded.has(a));
  if (unrecorded.length) gaps.push(`attempt(s) a rider was seen holding have no publication record: ${unrecorded.join(', ')}`);
  const pushGaps = [...new Set(e.offerPushes.map((p) => p.attemptId).filter((a): a is string => !!a))].filter((a) => !recorded.has(a));
  if (pushGaps.length) gaps.push(`persisted notification attempt(s) have no publication record: ${pushGaps.join(', ')}`);
  if (e.searches.length === 0) gaps.push('the dispatch journal has no search for the order');
  if (assignedSearches.length === 0) gaps.push('the dispatch journal records no assignment');
  out.push({
    name: 'durable: the evidence is complete — every attempt seen or accepted is on record, and the journal assigned the order',
    ok: gaps.length === 0,
    ...(gaps.length ? { inconclusive: true } : {}),
    detail: gaps.length ? gaps.join('; ') : `${recorded.size} attempt(s) on record, covering the ${new Set([...observedAttemptIds, ...(acceptedAttemptId ? [acceptedAttemptId] : [])]).size} seen or accepted; ${assignedSearches.length} assignment in ${e.searches.length} search(es)`,
  });
  return out;
}

interface CrashCtx extends Ctx { outDir: string }

// ── [AX370 A1] whose job a leg is, and who could be offered the drill order ──

/** What makes a job the drill's: an order THIS run placed (its ledger), by the plan's customer C5, at the plan's store R1. */
export interface DrillOwner { orders: string[]; customerUserId: string; storeVendorId: string }
export interface HeldLeg { riderId: string; orderId: string; status: string; leg: any }
export interface OnlineRiders { ok: boolean; riders: Array<{ id: string; phone: string }>; detail?: string }

const legIdOf = (leg: any): string => String(leg?.id ?? leg?.orderId ?? '');

/** Pure: a leg is the drill's to release only when ALL THREE hold; anything else is someone else's job. */
export function isDrillLeg(leg: any, owner: DrillOwner): boolean {
  const id = legIdOf(leg);
  const customer = String(leg?.customerId ?? leg?.customer?.id ?? '');
  const store = String(leg?.vendorId ?? leg?.vendor?.id ?? '');
  return id !== '' && owner.orders.includes(id)
    && owner.customerUserId !== '' && customer === owner.customerUserId
    && owner.storeVendorId !== '' && store === owner.storeVendorId;
}

/** Pure: every roster rider's legs, split into this run's own and everyone else's. */
export function splitLegs(held: Array<{ riderId: string; legs: any[] }>, owner: DrillOwner): { own: HeldLeg[]; other: HeldLeg[] } {
  const own: HeldLeg[] = [];
  const other: HeldLeg[] = [];
  for (const { riderId, legs } of held) {
    for (const leg of legs) (isDrillLeg(leg, owner) ? own : other).push({ riderId, orderId: legIdOf(leg), status: String(leg?.status ?? ''), leg });
  }
  return { own, other };
}

/**
 * Pure: the drill order's dispatch candidates are ONLINE riders of its tenant
 * (dispatch.service.ts; distance, freshness and capacity only narrow that), so
 * list is an additional sanity check within the protected run tenant. This
 * snapshot alone is never lifetime isolation; the fixture tenant is what
 * excludes outside accounts during subsequent activation and recovery.
 */
export function poolVerdict(read: OnlineRiders, rosterPhones: string[]): { ok: boolean; detail: string } {
  if (!read.ok) return { ok: false, detail: `${read.detail ?? 'the online-rider list could not be read'}: the pool cannot be proven roster-only` };
  const others = read.riders.filter((r) => !r.phone || !rosterPhones.includes(r.phone));
  return others.length
    ? { ok: false, detail: `${others.length} online rider(s) outside ${RIDERS.join('/')} could be offered the drill order: rider ${others.map((r) => r.id || '(no id)').join(', ')}` }
    : { ok: true, detail: `${read.riders.length} rider(s) online in the tenant, every one of them the drill's` };
}

/** The orders this run's ledger names — a ledger another run wrote proves nothing. */
function runOrders(outDir: string, runId: string): string[] {
  const l = readJson<{ runId?: string; orders?: unknown }>(join(outDir, LEDGER));
  return l?.runId === runId && Array.isArray(l.orders) ? l.orders.filter((x): x is string => typeof x === 'string') : [];
}

function recordPlaced(outDir: string, runId: string, orderId: string): void {
  writeFileSync(join(outDir, LEDGER), JSON.stringify({ runId, orders: [...new Set([...runOrders(outDir, runId), orderId])] }, null, 2) + '\n');
}

/** Read-only: this run's orders (plus `also`, the state's own), the plan's customer, and R1 as its own owner sees it. */
async function drillOwner(ctx: CrashCtx, also: string[] = []): Promise<DrillOwner> {
  const prof = (await GET('/vendor/profile', ctx.roster.vendors[STORE]!.session.token)).json?.data;
  const row = (Array.isArray(prof?.vendors) ? prof.vendors : [prof]).find((v: any) => v?.id) ?? null;
  return {
    orders: [...new Set([...runOrders(ctx.outDir, ctx.runId), ...also])],
    customerUserId: ctx.roster.customers[CUSTOMER]!.session.userId,
    storeVendorId: String(row?.id ?? ''),
  };
}

/** Read-only: every roster rider's live legs. A list that cannot be read proves nothing. */
async function rosterLegs(ctx: CrashCtx): Promise<{ ok: boolean; held: Array<{ riderId: string; legs: any[] }>; detail: string }> {
  const held: Array<{ riderId: string; legs: any[] }> = [];
  const unread: string[] = [];
  for (const id of RIDERS) {
    const r = await GET('/rider/orders/active-legs', mover(ctx, id).session.token);
    if (!r.ok) unread.push(`${id} (${r.status})`);
    held.push({ riderId: id, legs: activeLegsOf(r.json) });
  }
  return { ok: unread.length === 0, held, detail: unread.length ? `could not read the jobs of ${unread.join(', ')}` : `${held.reduce((n, h) => n + h.legs.length, 0)} job(s) across ${RIDERS.join('/')}` };
}

/** Read-only: every rider online in the admin's tenant, every page (GET /admin/riders?status=online). */
async function onlineRiders(ctx: CrashCtx): Promise<OnlineRiders> {
  const riders: OnlineRiders['riders'] = [];
  for (let page = 1; page <= 40; page += 1) {
    const r = await GET(`/admin/riders?status=online&limit=50&page=${page}`, ctx.admin.token);
    const rows = r.json?.data;
    if (!r.ok || r.json?.success !== true || !Array.isArray(rows)) return { ok: false, riders, detail: `the online-rider list could not be read (${r.status})` };
    for (const x of rows) riders.push({ id: String(x?.id ?? ''), phone: String(x?.user?.phone ?? '') });
    if (r.json?.meta?.hasNext !== true) return { ok: true, riders };
  }
  return { ok: false, riders, detail: 'over 2,000 riders online: the list was not read to its end' };
}

/** Release ONLY the given legs (each proven this run's); returns what could not be released. */
async function releaseOwn(ctx: CrashCtx, own: HeldLeg[]): Promise<string[]> {
  const left: string[] = [];
  for (const h of own) {
    const r = await releaseLeg(ctx, h.riderId, h.leg);
    if (!r.ok) left.push(`${h.riderId}: ${h.orderId} (${h.status}) → ${r.status} ${codeOf(r)}`);
  }
  return left;
}

/** The verify phase's last step: this run's own jobs are released; any other job a roster rider holds is named and left exactly as it is. */
async function releaseOwnAtEnd(ctx: CrashCtx, orderId: string): Promise<void> {
  try {
    const legs = splitLegs((await rosterLegs(ctx)).held, await drillOwner(ctx, [orderId]));
    for (const h of legs.other) ctx.log(`    ${h.riderId} holds order ${h.orderId} (${h.status}), not this run's: left untouched`);
    const left = await releaseOwn(ctx, legs.own);
    if (left.length) ctx.log(`    this run's own job(s) still held: ${left.join('; ')}`);
  } catch (e: any) {
    ctx.log(`    the riders' jobs could not be read (${e?.message ?? e}); nothing was released`);
  }
}

async function signIn(id: string, scope: CrashScope): Promise<{ id: string; phone: string; session: Session; lat: number; lng: number; kind?: 'rider' | 'driver'; vendorType?: string }> {
  const e = rosterEntry(id);
  if (!e) throw new Error(`no roster account ${id}`);
  const actor = id === CUSTOMER ? scope.customer : id === STORE ? scope.storeOwner : scope.riders[RIDERS.indexOf(id)]!;
  const session = await login(actor.phone);
  if (session.userId !== actor.userId) throw new Error(`isolated ${id} account identity changed`);
  return { ...e, phone: actor.phone, session, lat: 6.8013, lng: -58.1551 };
}

type PhaseOpts = { runId: string; identity: TargetIdentity; admin: Session; adminPhone: string; outDir: string; log: (s: string) => void };

/** Sign in only the actors named by the host-attested run fixture. */
function scopeFor(o: PhaseOpts): CrashScope {
  return parseCrashScope(readJson<CrashScope>(join(o.outDir, 'crash-drill-scope.json')), o.runId, o.identity);
}

async function world(o: PhaseOpts): Promise<CrashCtx> {
  const scope = scopeFor(o);
  const customer = await signIn(CUSTOMER, scope);
  const store = await signIn(STORE, scope);
  const riders = await Promise.all(RIDERS.map((id) => signIn(id, scope)));
  const admin = await login(scope.admin.phone);
  if (admin.userId !== scope.admin.userId) throw new Error('isolated admin identity changed');
  const roster: Roster = {
    customers: { [CUSTOMER]: customer },
    vendors: { [STORE]: { ...store, vendorType: store.vendorType ?? 'RESTAURANT' } },
    movers: Object.fromEntries(riders.map((r) => [r.id, { ...r, kind: 'rider' as const }])),
    admin2: null,
  };
  const w: World = { items: {}, liveVendors: [], readyMovers: [], onlineMovers: [], notReady: {}, providers: {} };
  return { runId: o.runId, log: o.log, identity: o.identity, admin, adminPhone: scope.admin.phone, roster, world: w, stash: { heartbeatOverrides: {} }, drill: null, outDir: o.outDir };
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
  rec.require(`${STORE} is open, accepting and has an item (provisioned in this run’s isolated fixture tenant)`, row?.status === 'ACTIVE' && open && accepting && !!plate,
    `status=${row?.status} open=${open} accepting=${accepting} item=${plate?.name ?? 'none'}`);
}

/** Riders online at their roster homes. What they hold was settled before (setup) or is not the drill's to touch (verify). */
async function ridersOnline(rec: Recorder, ctx: CrashCtx): Promise<void> {
  for (const id of RIDERS) {
    const m = mover(ctx, id);
    const on = await goOnline(m);
    if (on.ok || codeOf(on) === 'ALREADY_ONLINE') {
      await ping(m);
      ctx.world.onlineMovers.push(id);
      ctx.world.readyMovers.push(id);
    }
  }
  rec.require('roster riders are online near the store', ctx.world.onlineMovers.length > 0, `online: ${ctx.world.onlineMovers.join(' ') || 'none'}`);
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

/** [AX324 R7] EVERY roster rider whose active legs include the order — never just the first. */
async function holdersOf(ctx: CrashCtx, orderId: string): Promise<string[]> {
  const out: string[] = [];
  for (const id of RIDERS) {
    const legs = activeLegsOf((await GET('/rider/orders/active-legs', mover(ctx, id).session.token)).json);
    if (legs.some((l) => (l.id ?? l.orderId) === orderId)) out.push(id);
  }
  return out;
}

/** Phase 1: prove the dead-letter page empty, reach mid-offer, record it, exit. */
export async function crashSetup(o: PhaseOpts): Promise<number> {
  try { scopeFor(o); } catch (e) { o.log(String(e)); return 1; }
  const ctx = await world(o);
  const run = new JourneyRun<CrashCtx>({ id: 'PLAT-02', title: 'setup', cases: '', run: async () => undefined });
  const rec = run.rec;
  const setupStartedAt = new Date().toISOString();
  let stop = () => {};
  try {
    const base = dlqVerdict(await GET('/admin/dlq', ctx.admin.token));
    rec.require('the dead-letter page is valid and empty before the crash (PLAT-02 can pass only on an empty page; drain it first)', base.ok, base.detail);
    // [AX370 A1] Read-only, before the first write: every job a roster rider
    // holds is PROVEN this run's own, and no other rider could be offered the order.
    const held = await rosterLegs(ctx);
    rec.require(`the jobs of ${RIDERS.join('/')} were read`, held.ok, held.detail);
    const legs = splitLegs(held.held, await drillOwner(ctx));
    rec.require('no roster rider holds a job this run cannot prove its own (in its ledger, placed by C5 at R1) — refused before setup, nothing touched',
      legs.other.length === 0,
      legs.other.length ? `not this run's: ${legs.other.map((h) => `order ${h.orderId} (${h.status}) held by ${h.riderId}`).join('; ')}` : `${legs.own.length} job(s) of this run to release`);
    const pool = poolVerdict(await onlineRiders(ctx), RIDERS.map((id) => mover(ctx, id).phone));
    rec.require('the drill order can be offered only to the drill’s riders: no other rider is online in the tenant — refused before setup', pool.ok, pool.detail);

    await storeReady(rec, ctx);
    const left = await releaseOwn(ctx, legs.own);
    if (left.length) o.log(`    this run's own job(s) still held: ${left.join('; ')}`);
    await ridersOnline(rec, ctx);
    stop = startHeartbeat(ctx.roster, ctx.world, {});
    const placed = await placeExpress(ctx, CUSTOMER, STORE, STORE, `crash-${o.runId}`);
    // [AX370 A1] Recorded before anything else can fail: the run's provenance for every later cleanup.
    if (placed.id) recordPlaced(o.outDir, o.runId, placed.id);
    rec.require('an express cash delivery (no hold)', !!placed.id, brief(placed.res));
    rec.expect('the store accepts it (dispatch starts on accept)', await storeAccepts(ctx, STORE, placed.id!), 200);
    let got: Sighting[] = [];
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && got.length === 0) {
      got = await sightings(ctx, placed.id!);
      if (!got.length) await sleep(1_000);
    }
    rec.require('mid-offer: a rider holds a live offer for the order', got.length === 1, got.length ? `${got.map((g) => `${g.moverId} holds ${g.offerAttemptId}`).join('; ')}` : 'no offer within 60 s');
    const state: CrashState = {
      runId: o.runId,
      setupStartedAt,
      tenantId: scopeFor(o).tenantId,
      riderUsers: scopeFor(o).riders.map((r) => r.userId),
      orderId: placed.id!,
      offer: { moverId: got[0]!.moverId, offerAttemptId: got[0]!.offerAttemptId, seenAt: new Date(got[0]!.at).toISOString() },
      steps: [...rec.steps],
      negatives: rec.negatives,
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

const readJson = <T>(path: string): T | null => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null);

function loadState(outDir: string, runId: string): CrashState {
  const state = readJson<CrashState>(join(outDir, STATE));
  if (!state) throw new Error(`${STATE} is missing in ${outDir}: run the setup phase first (deploy/drill-crash.sh does)`);
  // [AX370 A1] Run provenance: an order another run recorded is not this run's to walk, judge or release.
  if (state.runId !== runId) throw new Error(`${STATE} in ${outDir} was written by run ${state.runId}, not ${runId}: its order is not this run's`);
  return state;
}

/** Phase 3: after the restart — resumed, one completion, every rider watched throughout; the record for finalize. */
export async function crashVerify(o: PhaseOpts): Promise<number> {
  try { scopeFor(o); } catch (e) { o.log(String(e)); return 1; }
  const state = loadState(o.outDir, o.runId);
  if (state.tenantId !== scopeFor(o).tenantId) { o.log('isolated crash state tenant changed'); return 1; }
  const host = readJson<CrashHost>(join(o.outDir, HOST));
  const ctx = await world(o);
  const record: CrashVerify = { runId: o.runId, orderId: state.orderId, steps: [], negatives: 0, acceptedAttemptId: null, observedAttemptIds: [], finishedAt: '' };
  const run = new JourneyRun<CrashCtx>({ id: 'PLAT-02', title: 'verify', cases: '', run: (rec, c) => verifyRun(rec, c, state, host, record) });
  await run.run(ctx);
  record.steps = [...run.rec.steps];
  record.negatives = run.rec.negatives;
  record.finishedAt = new Date().toISOString();
  writeFileSync(join(o.outDir, VERIFY), JSON.stringify(record, null, 2) + '\n');
  for (const s of record.steps) if (!s.ok) o.log(`    ✗ ${s.name} — ${s.detail.slice(0, 240)}`);
  o.log(`  verify recorded ${record.steps.length} step(s); the host reads the durable evidence next`);
  return record.steps.some((s) => !s.ok) ? 1 : 0;
}

async function verifyRun(rec: Recorder, ctx: CrashCtx, state: CrashState, host: CrashHost | null, record: CrashVerify): Promise<void> {
  rec.check('the host killed the worker mid-offer (SIGKILL, no drain) and started it again after the wait',
    !!host && host.signal === 'SIGKILL' && host.downRightAfterKill,
    host ? `${host.worker}: killed ${host.killedAt}, down=${host.downRightAfterKill}, still down after ${host.waitSeconds}s=${host.downAfterTheWait}, started ${host.restartedAt}` : `${HOST} missing: the host step did not record the crash`);
  const restartedAt = host ? Date.parse(host.restartedAt) : Date.now();
  const offerPolls: Sighting[][] = [[{ at: Date.parse(state.offer.seenAt), moverId: state.offer.moverId, offerAttemptId: state.offer.offerAttemptId }]];
  const assignedPolls: Sighting[][] = [];
  const holderPolls: string[][] = [];
  let assigned = false;
  // [AX324 R7] One observation = every rider's live offers AND legs; it never stops until the tail after completion.
  const observe = async (): Promise<Sighting[]> => {
    const now = await sightings(ctx, state.orderId);
    (assigned ? assignedPolls : offerPolls).push(now);
    holderPolls.push(await holdersOf(ctx, state.orderId));
    return now;
  };
  let stop = () => {};
  try {
    await ridersOnline(rec, ctx);
    stop = startHeartbeat(ctx.roster, ctx.world, {});
    const C = ctx.roster.customers[CUSTOMER]!.session;

    // 1. Resumed or reconciled, within the window.
    let live: Sighting | null = null;
    const deadline = restartedAt + RESUME_WINDOW_MS;
    while (Date.now() < deadline) {
      const now = await observe();
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

    // 2. One completion, observed at every step: the live offer is taken and the order walked to the door.
    if (live) {
      const m = mover(ctx, live.moverId);
      const took = await POST('/rider/offers/accept', { orderId: state.orderId, offerAttemptId: live.offerAttemptId }, m.session.token);
      rec.expect('the rider takes the resumed offer', took, 200);
      if (took.ok) { assigned = true; record.acceptedAttemptId = live.offerAttemptId; }
    }
    await observe();
    const holders = await holdersOf(ctx, state.orderId);
    rec.check('exactly one rider holds the order (every roster rider asked)', holders.length === 1, holders.length ? holders.join(', ') : 'no roster rider holds it');
    if (holders.length === 1) {
      const m = mover(ctx, holders[0]!);
      await storeReadies(ctx, STORE, state.orderId);
      await observe();
      const walked = await riderToDoor(m.session, state.orderId);
      rec.expect('the rider carries it to the door', walked, 200);
      await observe();
      const handed = await handoverPaid(m.session, state.orderId, { lat: ctx.roster.customers[CUSTOMER]!.lat, lng: ctx.roster.customers[CUSTOMER]!.lng }, await doorPin(C, state.orderId));
      rec.expect('the cash is handed over at the door', handed, [200, 201]);
    }
    // The tail: observation continues after completion.
    for (let i = 0; i < TAIL_POLLS; i += 1) { await sleep(2_000); await observe(); }

    const once = onceOnly(offerPolls);
    rec.check('nothing ran twice before the assignment: never two live offers for the order at once, and no replaced attempt came back', once.ok, once.detail);
    const after = noOfferAfterAssignment(assignedPolls);
    rec.check('nothing ran twice after it: no live offer for the order once assigned, through completion', assigned && after.ok, assigned ? after.detail : 'the order was never assigned');
    const held = holdersVerdict(holderPolls);
    rec.check('one holder for the whole window: never two riders at once, and only one ever', held.ok, held.detail);

    const detail = await GET(`/admin/orders/${state.orderId}`, ctx.admin.token);
    const history: any[] = Array.isArray(detail.json?.data?.statusHistory) ? detail.json.data.statusHistory : [];
    const count = (s: string) => history.filter((h) => h.status === s).length;
    const final = detail.json?.data?.status;
    rec.check('the order ends in a sane state, completed exactly once', detail.ok && ['DELIVERED', 'COMPLETED'].includes(final) && count('DELIVERED') === 1 && count('RIDER_ASSIGNED') === 1,
      `status=${final} · DELIVERED logged ${count('DELIVERED')}× · RIDER_ASSIGNED logged ${count('RIDER_ASSIGNED')}× · ${history.length} status rows`);

    // 3. [AX324 R8] The dead-letter page: valid and EMPTY — it was empty before the crash, so nothing is filtered away.
    const dead = await GET('/admin/dlq', ctx.admin.token);
    const dl = dlqVerdict(dead);
    rec.check('the dead-letter page is valid and empty: no job failed for good', dl.ok, dl.detail);
    const rows: any[] = Array.isArray(dead.json?.data) ? dead.json.data : [];
    rec.check('every listed dead letter states its recovery class', rows.every((r) => r.recovery != null), `${rows.length} row(s)`);
    rec.deny('a non-founder cannot read the DLQ', await GET('/admin/dlq', C.token), [403]);
    rec.deny('requeue of a job that does not exist', await POST(`/admin/dlq/dispatch/${FORGED}/requeue`, {}, ctx.admin.token), [400, 404]);
  } finally {
    stop();
    record.observedAttemptIds = [...new Set([...offerPolls, ...assignedPolls].flat().map((s) => s.offerAttemptId))];
    await releaseOwnAtEnd(ctx, state.orderId);
    for (const id of RIDERS) await goOffline(mover(ctx, id)).catch(() => undefined);
  }
}

/** Phase 5: the durable evidence judged with the live record; the PLAT-02 row. */
export async function crashFinalize(o: PhaseOpts): Promise<number> {
  const state = loadState(o.outDir, o.runId);
  const verify = readJson<CrashVerify>(join(o.outDir, VERIFY));
  const evidence = readJson<CrashEvidence>(join(o.outDir, EVIDENCE));
  const journey: Journey<null> = {
    id: 'PLAT-02',
    title: 'Worker restart / job recovery mid-flow',
    cases: 'worker crash mid-offer/hold; DLQ; retry; once-only completion',
    run: async (rec) => finalizeRun(rec, state, verify, evidence),
  };
  const run = new JourneyRun(journey);
  run.rec.steps.push(...state.steps.map((s) => ({ ...s, name: `setup: ${s.name}` })));
  run.rec.steps.push(...(verify?.steps ?? []));
  run.rec.negatives = (state.negatives ?? 0) + (verify?.negatives ?? 0);
  await run.run(null);
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

function finalizeRun(rec: Recorder, state: CrashState, verify: CrashVerify | null, evidence: CrashEvidence | null): void {
  const gaps: string[] = [];
  if (!state.tenantId || state.tenantId !== crashTenantId(state.runId)) gaps.push('isolated tenant provenance is absent from setup');
  if (!verify || verify.orderId !== state.orderId || verify.runId !== state.runId) {
    gaps.push(`${VERIFY} is absent or does not identify this run and order`);
  }
  const ok = !!evidence && evidence.version === 1 && evidence.orderId === state.orderId;
  if (!ok) gaps.push(`${EVIDENCE} is absent or does not identify this order`);
  if (ok) {
    if (!evidence!.order?.tenantId) gaps.push('the durable order tenant is absent');
    else rec.check('durable: the order stayed in the isolated run tenant', evidence!.order.tenantId === state.tenantId, evidence!.order.tenantId);
    if (!state.riderUsers?.length) gaps.push('the isolated rider identities are absent from setup');
    else {
      const outside = [...evidence!.offers.map((a) => a.recipientId), ...evidence!.offerPushes.map((p) => p.userId)].filter((u) => !state.riderUsers.includes(u));
      rec.check('durable: every offer recipient is an isolated run rider', outside.length === 0, outside.length ? `outside run: ${[...new Set(outside)].join(', ')}` : 'all recorded offer recipients belong to this run');
    }
    const checks = durableOnceOnly(evidence!, verify?.acceptedAttemptId ?? null, [state.offer.offerAttemptId, ...(verify?.observedAttemptIds ?? [])]);
    // A demonstrated duplicate still fails even beside missing evidence.
    for (const c of checks) {
      if (c.inconclusive) gaps.push(c.detail);
      else rec.check(c.name, c.ok, c.detail);
    }
  }
  if (gaps.length) rec.skipAll(`INCONCLUSIVE — the durable evidence is incomplete, so nothing proves the crash window ran once: ${gaps.join('; ')}`);

}

/** Entry for run.ts --suite=crash-drill --phase=setup|verify|finalize: the same refusals as the journeys suite, then the phase. */
export async function crashDrill(phase: string | undefined, log: (s: string) => void): Promise<number> {
  if (phase !== 'setup' && phase !== 'verify' && phase !== 'finalize') throw new Error('--phase=setup|verify|finalize is required');
  const runId = process.env.LIVETEST_RUN_ID || '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) throw new Error('LIVETEST_RUN_ID must name the journeys run the PLAT-02 row belongs to');
  const outDir = process.env.LIVETEST_OUT_DIR || '';
  if (!outDir) throw new Error('LIVETEST_OUT_DIR is required (deploy/drill-crash.sh mounts the run results at /results)');
  const scope = parseCrashScope(readJson<CrashScope>(join(outDir, 'crash-drill-scope.json')), runId, { deploymentId: process.env.LIVETEST_EXPECT_DEPLOYMENT_ID ?? '', environment: process.env.LIVETEST_EXPECT_ENVIRONMENT ?? '' });
  const phones = [scope.customer, scope.storeOwner, ...scope.riders].map((a) => a.phone);
  const adminPhone = requireAdminPhone(process.env.LIVETEST_ADMIN_PHONE);
  refuseLivePhones([...phones, adminPhone]);
  await refusePublicTarget(ORIGIN);
  let admin: Session | null = null;
  const identity = await refuseUnsafeIdentity(
    { get: async (p, token) => { const r = await GET(p, token); return { status: r.status, json: r.json }; } },
    async () => { admin = await login(adminPhone); return admin.token; },
  );
  parseCrashScope(scope, runId, identity);
  log(`\nPLAT-02 crash drill (${phase}) → ${ORIGIN} · deployment ${identity.deploymentId} · run ${runId}\n`);
  const o = { runId, identity, admin: admin!, adminPhone, outDir, log };
  return phase === 'setup' ? crashSetup(o) : phase === 'verify' ? crashVerify(o) : crashFinalize(o);
}
