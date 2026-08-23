/**
 * ELV-2 A12 — Scenario B14: SAFETY, HONEST STATUS.
 *
 * The safety law: the status a person sees must state ONLY what actually
 * happened on the server. A "help is on the way" strip while nothing has been
 * dispatched is the most dangerous lie the product can tell.
 *
 * Proves, live:
 *   1. GRACE IS HONEST — a raised SOS opens at TRIGGER_PENDING with a real
 *      graceEndsAt, and NOBODY has been paged yet (no ops/contact rows).
 *   2. CANCEL-IN-GRACE SAYS NOTHING HAPPENED — the alert lands CANCELLED and
 *      still zero notifications: an aborted alert never claims a rescue.
 *   3. CONFIRM MAKES IT TRUE — TRIGGER_PENDING → ACTIVE fans out for real
 *      (admin/ops rows exist), so the strip may finally say help is coming.
 *   4. AFTER ACTIVE, CANCEL IS IMPOSSIBLE — 409 with honest copy, not a
 *      silent no-op the UI could render as "cancelled".
 *   5. "I'M SAFE" NEVER RESOLVES — mark-safe flags the alert; ops still own
 *      closure (status stays ACTIVE).
 *   6. SOS IS EXEMPT FROM RATE LIMITS (LHC-1 K2) — rapid repeat triggers are
 *      all accepted; a limiter must never stand between a person and help.
 *   7. REPLAY IS ONE ALERT, PER PERSON — the same clientIdempotencyKey
 *      returns the original; the SAME key from a second person raises THEIR
 *      OWN alert (never a handback of the first person's); and concurrent
 *      retries from one device settle on one alert with no error.
 *   8. SOMEONE ELSE'S ALERT IS NOT YOURS — read/confirm/cancel by another
 *      authenticated user is refused with an explicit 403/404, and the alert
 *      is unmoved afterwards.
 *   9. TRIP SHARE — a minted share is publicly viewable WITHOUT auth, the
 *      payload is under the 300KB budget, and revoking it 404s.
 *
 * Every alert this script raises is DELETED before exit (never force-resolved
 * — a RESOLVED row with no ops actor is a closure the product could not have
 * produced), swept by actor as well as by tracked id so a lost response cannot
 * strand one, from the finally path; rides are cancelled the same way. A
 * teardown that cannot verify itself fails the run.
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b14-safety-honest.ts
 */
import { PrismaClient } from '@prisma/client';
import { sosReachedAnyone } from '../../src/modules/safety/delivery-proof';
import { randomInt } from 'node:crypto';

const A = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const HEALTH = A.replace('/api/v1', '') + '/health';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';
const OTHER_PHONE = '+5925566009'; // the tier-probe account doubles as "someone else"

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${A}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, json, bytes: Buffer.byteLength(text) };
}

const pickToken = (j: any): string | undefined =>
  j?.data?.tokens?.accessToken ?? j?.data?.tokens?.token ?? j?.data?.token ?? j?.data?.accessToken;

async function loginByOtp(phone: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await http('POST', '/auth/send-otp', { phone });
    const v = await http('POST', '/auth/verify-otp', { phone, code: '000000' });
    const t = pickToken(v.json);
    if (t) return t;
    if (attempt === 6) throw new Error(`no token for ${phone}`);
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error('unreachable');
}

/** Everything the fan-out could possibly have done, not just the inbox rows.
 *  [F-026-11] Counting Notification rows alone was NOT "the only proof a page
 *  happened": production also emits straight to the war-room socket and SMSs
 *  verified emergency contacts, neither of which writes one. The alert's own
 *  deliveryReceipts is the durable record of EVERY channel (opsPaged, socket,
 *  contacts), so silence has to mean silence there too. */
async function reachOf(alertId: string): Promise<{ notices: number; receipts: unknown; anyChannel: boolean }> {
  const [notices, alert] = await Promise.all([
    prisma.notification.count({ where: { data: { path: ['sosAlertId'], equals: alertId } as never } }),
    prisma.sosAlert.findUnique({ where: { id: alertId }, select: { deliveryReceipts: true } }),
  ]);
  const receipts = (alert?.deliveryReceipts ?? null) as Record<string, unknown> | null;
  // [F-027-16] "The receipts object has ANY key" was not evidence of reach —
  // it was evidence that fan-out RAN. A total failure writes
  // {opsPaged: 0, socketListeners: 0, contacts: ...}, which is nonempty, so
  // the old oracle accepted an ACTIVE alert that reached nobody as proof that
  // help was coming. Only POSITIVE, per-channel evidence counts now.
  // [F-028-06] The judgement of "did help reach anyone" lives in ONE tested
  // module now — this oracle produced two S0 false positives in a row by
  // re-deriving it locally (all-failed SMS arrays counted by length;
  // war-room MEMBERSHIP counted as delivery though no shipped client has a
  // handler). See modules/safety/delivery-proof.ts for the rules.
  const anyChannel = sosReachedAnyone(receipts, notices);
  return { notices, receipts, anyChannel };
}

const raised: string[] = [];
/** [F-027-19] The two test actors. Teardown sweeps by ACTOR as well as by
 *  tracked id, so an alert whose POST committed but whose response was lost —
 *  and therefore never entered `raised` — cannot be stranded on the rig. */
const actorIds: string[] = [];
/** [F-026-19] Rides raised by this run, torn down from the finally path. */
const rides: string[] = [];
/** The owner token, published for the finally-path teardown so it can use the
 *  product cancel rather than only a raw force-close. */
let teardownToken: string | undefined;

async function main() {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const other = await prisma.user.findFirstOrThrow({ where: { phone: OTHER_PHONE } });
  const token = await loginByOtp(CUSTOMER_PHONE);
  teardownToken = token;
  // [F-026-18] The second actor is a MANDATORY fixture, not a nice-to-have.
  // Swallowing its login turned the entire authorization leg into a logged
  // note that still reached COMPLETE — an unavailable probe account is not
  // evidence that strangers cannot read your emergency.
  const otherToken = await loginByOtp(OTHER_PHONE);
  actorIds.push(customer.id, other.id);
  log('actors ready', { customer: customer.id, otherActor: other.id });

  // [F-027-17 follow-on] PREFLIGHT: these actors must start with no live
  // alert. Repeat triggers now collapse onto an open alert, so a single stray
  // one — left by a crashed run, or raised by the guardian sweep against a
  // ride this script created earlier — silently turns leg 1's fresh trigger
  // into someone else's ACTIVE alert and the whole run reports nonsense.
  // Closed LOUDLY, never silently: a rig accumulating live SOS rows is itself
  // worth seeing.
  const strays = await prisma.sosAlert.findMany({
    where: { actorUserId: { in: [customer.id, other.id] }, status: { in: ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] } },
    select: { id: true, status: true, triggerSource: true, triggeredAt: true },
  });
  if (strays.length > 0) {
    // [F-027-19] Deleted, not force-RESOLVED: a RESOLVED row with no ops
    // actor and no resolution code is a closure the product could never have
    // produced, and leaving one behind is exactly the fabricated evidence
    // this baseline exists to refuse.
    log('PREFLIGHT deleting stray live alerts left on the rig', strays);
    // [F-028-16] Through the evidence-first helper: a crashed run's alert may
    // own an evidence bundle, and deleting around it strands rows no
    // alert-based sweep can find again.
    await deleteSyntheticAlerts(strays.map((s) => s.id));
    const left = await prisma.sosAlert.count({
      where: { actorUserId: { in: [customer.id, other.id] }, status: { in: ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] } },
    });
    if (left > 0) throw new Error(`PREFLIGHT FAILED: ${left} live alert(s) survived — this run cannot tell its own alerts apart from them`);
  }

  // ── 1. grace is honest: pending, and NOBODY paged yet ────────────────────
  const t1 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token);
  if (t1.status >= 300) throw new Error(`sos ${t1.status}: ${JSON.stringify(t1.json).slice(0, 250)}`);
  const a1 = t1.json.data;
  raised.push(a1.id);
  if (a1.status !== 'TRIGGER_PENDING') throw new Error(`FAIL: expected TRIGGER_PENDING, got ${a1.status}`);
  if (!a1.graceEndsAt || new Date(a1.graceEndsAt) <= new Date()) throw new Error('FAIL: no live grace window returned — the countdown strip would be a fiction');
  // [F-026-11] Sample ACROSS the window rather than once immediately: a late
  // or delayed page would slip past a single instantaneous check.
  // [F-027-16] Sample the WHOLE window. Stopping 200ms short left the final
  // slice — the one immediately before escalation, where an off-by-one page is
  // most likely — unobserved, while the log claimed "across the WHOLE window".
  //
  // The margin is gone entirely. Instead of guessing how close to the deadline
  // is safe, the oracle asks the right question: reach is a VIOLATION only
  // while the alert is still TRIGGER_PENDING. A page at or after the deadline
  // is the escalation working, not a leak — so a late sample that finds the
  // alert already ACTIVE proves nothing either way and must not fail the run.
  const graceEnds = new Date(a1.graceEndsAt).getTime();
  let graceReach = await reachOf(a1.id);
  let stillPending = true;
  while (Date.now() <= graceEnds && !graceReach.anyChannel) {
    await new Promise((r) => setTimeout(r, 100));
    graceReach = await reachOf(a1.id);
    stillPending = (await prisma.sosAlert.findUniqueOrThrow({ where: { id: a1.id }, select: { status: true } })).status === 'TRIGGER_PENDING';
    if (!stillPending) break; // the deadline passed and it escalated — correct
  }
  if (graceReach.anyChannel && stillPending) throw new Error(`FAIL: the alert reached someone while STILL TRIGGER_PENDING (notices=${graceReach.notices}, receipts=${JSON.stringify(graceReach.receipts)}) — it has not been confirmed`);
  log('EVIDENCE grace is honest across the WHOLE window', { status: a1.status, graceEndsAt: a1.graceEndsAt, notices: 0, receipts: null });

  // ── 1b. the collapse, proven at the WIRE ────────────────────────────────
  // [F-027-17] Leg 2 needs a FRESH alert, and it can no longer just ask for
  // one: while an alert is live, a repeat trigger deliberately collapses onto
  // it so a burst cannot bury the ops desk. Prove that on the real route
  // before working around it — the unit tests exercise the service, this
  // exercises what a tapping thumb actually reaches.
  const collapse = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token);
  if (collapse.status !== 200) throw new Error(`FAIL: a repeat trigger was REFUSED (${collapse.status}) — collapsing must never mean rejecting`);
  if (collapse.json.data.id !== a1.id) throw new Error(`FAIL: a repeat trigger minted a SECOND alert (${collapse.json.data.id} vs ${a1.id}) — a burst can still bury ops`);
  const collapsed = await prisma.sosAlert.findUniqueOrThrow({ where: { id: a1.id }, select: { retriggerCount: true } });
  if (collapsed.retriggerCount < 1) throw new Error('FAIL: the repeat trigger left no trace — ops cannot see rising urgency');
  log('EVIDENCE a repeat trigger collapses onto the live alert and records urgency', { id: a1.id, retriggerCount: collapsed.retriggerCount });

  // ── 2. cancel in grace: nothing happened, and it still says nothing ──────
  // A FRESH alert is required, and leg 1's is now past its deadline (it spent
  // the whole window sampling), so cancelling it is correctly refused by the
  // F-026-12 clock guard. [F-028-16] DELETED, not force-RESOLVED: labelling
  // the write "not an ops resolution" documented the fabrication without
  // making the row valid — a RESOLVED alert with no ops actor, no resolution
  // code and no all-clear is a closure the product could never produce, and a
  // crash right after the write left it for anything downstream to read as a
  // real one. This is the run's own synthetic alert; the honest end state is
  // that it does not exist.
  await deleteSyntheticAlerts([a1.id]);
  const t1b = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token);
  const a1b = t1b.json.data;
  raised.push(a1b.id);
  const c1 = await http('POST', `/safety/sos/${a1b.id}/cancel`, {}, token);
  if (c1.status >= 300) throw new Error(`cancel ${c1.status}: ${JSON.stringify(c1.json).slice(0, 200)}`);
  if (c1.json.data.status !== 'CANCELLED') throw new Error(`FAIL: cancel left status ${c1.json.data.status}`);
  // Wait past the moment it WOULD have escalated before declaring silence.
  const cancelWindowEnds = new Date(a1b.graceEndsAt).getTime();
  const waitPastWindow = cancelWindowEnds + 1_500 - Date.now();
  if (waitPastWindow > 0) await new Promise((r) => setTimeout(r, waitPastWindow));
  const cancelReach = await reachOf(a1b.id);
  if (cancelReach.anyChannel) throw new Error(`FAIL: a CANCELLED alert reached someone (notices=${cancelReach.notices}, receipts=${JSON.stringify(cancelReach.receipts)})`);
  log('EVIDENCE cancelled-in-grace pages nobody, even past its own deadline', { status: c1.json.data.status, notices: 0, receipts: null });

  // ── 3. confirm makes "help is coming" TRUE ──────────────────────────────
  const t2 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token);
  const a2 = t2.json.data;
  raised.push(a2.id);
  const conf = await http('POST', `/safety/sos/${a2.id}/confirm`, {}, token);
  if (conf.status >= 300) throw new Error(`confirm ${conf.status}`);
  if (conf.json.data.status !== 'ACTIVE') throw new Error(`FAIL: confirm left status ${conf.json.data.status}`);
  let confirmReach = await reachOf(a2.id);
  for (let i = 0; i < 20 && !confirmReach.anyChannel; i++) {
    await new Promise((r) => setTimeout(r, 500));
    confirmReach = await reachOf(a2.id);
  }
  if (!confirmReach.anyChannel) throw new Error('FAIL: an ACTIVE alert reached NOBODY — the strip would claim a rescue that never started');
  log('EVIDENCE confirmed alert really fans out', { status: conf.json.data.status, notices: confirmReach.notices, receipts: confirmReach.receipts });

  // ── 4. after ACTIVE, cancel is impossible — and says so honestly ─────────
  const lateCancel = await http('POST', `/safety/sos/${a2.id}/cancel`, {}, token);
  if (lateCancel.status !== 409) throw new Error(`FAIL: cancelling an ACTIVE alert returned ${lateCancel.status}, expected 409`);
  const stillActive = await prisma.sosAlert.findUniqueOrThrow({ where: { id: a2.id }, select: { status: true } });
  if (stillActive.status !== 'ACTIVE') throw new Error(`FAIL: a refused cancel still moved the alert to ${stillActive.status}`);
  log('EVIDENCE active alert cannot be cancelled', { status: lateCancel.status, code: lateCancel.json?.error?.code, alertStatus: stillActive.status });

  // ── 5. "I'm safe" flags, never resolves ─────────────────────────────────
  const safe = await http('POST', `/safety/sos/${a2.id}/mark-safe`, {}, token);
  if (safe.status >= 300) throw new Error(`mark-safe ${safe.status}`);
  if (!safe.json.data.userSafeFlaggedAt) throw new Error('FAIL: mark-safe recorded no flag');
  if (safe.json.data.status !== 'ACTIVE') throw new Error(`FAIL: "I'm safe" RESOLVED the alert (${safe.json.data.status}) — only ops may close it`);
  log('EVIDENCE I-am-safe flags but never resolves', { status: safe.json.data.status, flaggedAt: safe.json.data.userSafeFlaggedAt });

  // ── 5b. someone else's alert is not yours ───────────────────────────────
  // Runs here, while a2 is freshly ACTIVE and before the burst and the
  // idempotency legs mutate the actor's live-alert state — those legs need
  // NO live alert, this one needs exactly this one.
  // [F-026-18] Assert the EXACT refusal. `< 400` accepted a 500 or a
  // connection-level failure as proof of authorization, which is the opposite
  // of what it claims: an outage is not a permission check. And the promised
  // cross-user CANCEL was never attempted at all.
  const DENIED = [403, 404];
  const denialOf = (label: string, r: { status: number; json: unknown }) => {
    if (!DENIED.includes(r.status)) {
      throw new Error(`FAIL: another user's ${label} on this alert returned ${r.status} — expected an explicit refusal (${DENIED.join('/')}), and a server error is NOT a denial: ${JSON.stringify(r.json).slice(0, 200)}`);
    }
    return r.status;
  };
  const peek = denialOf('READ', await http('GET', `/safety/sos/${a2.id}`, undefined, otherToken));
  const hijack = denialOf('CONFIRM', await http('POST', `/safety/sos/${a2.id}/confirm`, {}, otherToken));
  const kill = denialOf('CANCEL', await http('POST', `/safety/sos/${a2.id}/cancel`, {}, otherToken));
  const untouched = await prisma.sosAlert.findUniqueOrThrow({ where: { id: a2.id }, select: { status: true } });
  if (untouched.status !== 'ACTIVE') throw new Error(`FAIL: the refused cross-user calls still moved the alert to ${untouched.status}`);
  log('EVIDENCE cross-user read/confirm/cancel all refused, alert untouched', { read: peek, confirm: hijack, cancel: kill, status: untouched.status });


  // ── 6. SOS is exempt from rate limiting (LHC-1 K2) ──────────────────────
  // [F-026-13] Five requests proved nothing: the global ceiling is 200/min, so
  // a five-shot burst never reaches it, and "not 429" would also be satisfied
  // by five 401s or 500s. Fire ABOVE the configured ceiling and require every
  // response to be a real, well-formed alert.
  const CEILING = Number(process.env['RATE_LIMIT_MAX'] ?? 200);
  const burstSize = CEILING + 20;
  // The rate limiter counts REQUESTS PER MINUTE, so exceeding the ceiling
  // inside the window is what proves the exemption — firing all 220 at the
  // same instant additionally saturates the connection pool and turns this
  // leg into a database stress test whose red says nothing about limiting.
  // Waves keep the claim honest and the measurement on its own subject.
  const WAVE = 20;
  const burst: Array<{ status: number; json: any; bytes: number }> = [];
  for (let i = 0; i < burstSize; i += WAVE) {
    // [F-026-16] Record each id AS IT ARRIVES. Collecting them after the whole
    // batch settled meant one rejected sibling could hide every successful
    // alert from teardown — leaving live SOS rows behind on a "green" run.
    burst.push(...await Promise.all(Array.from({ length: Math.min(WAVE, burstSize - i) }, () =>
      http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token)
        .then((r) => { if (r.json?.data?.id) raised.push(r.json.data.id); return r; }))));
  }
  const limited = burst.filter((r) => r.status === 429);
  if (limited.length > 0) throw new Error(`FAIL K2: ${limited.length}/${burstSize} SOS triggers were RATE-LIMITED past the ${CEILING}/min ceiling — a limiter must never stand between a person and help`);
  // [F-250] A burst that comes back 401 is the OTHER way to lock someone out
  // of help: the session store fell over and the API called it a credential
  // problem. Name it separately so the failure text points at the real system.
  const lied = burst.filter((r) => r.status === 401);
  if (lied.length > 0) throw new Error(`FAIL F-250: ${lied.length}/${burstSize} triggers answered 401 "invalid or expired token" with a VALID token — an outage reported as a credential verdict`);
  const unavailable = burst.filter((r) => r.status === 503);
  if (unavailable.length > 0) throw new Error(`FAIL: ${unavailable.length}/${burstSize} triggers were 503 — the rig could not serve the burst, so this leg proves nothing about rate limiting (honest error, wrong subject)`);
  const malformed = burst.filter((r) => r.status !== 200 || !r.json?.data?.id || !r.json?.data?.status);
  if (malformed.length > 0) throw new Error(`FAIL: ${malformed.length}/${burstSize} triggers did not return a well-formed alert (first: ${malformed[0]!.status} ${JSON.stringify(malformed[0]!.json).slice(0, 160)})`);
  // [F-027-17] The same burst measures the OTHER half of the trade: an exempt
  // route must not become an unbounded alert mint that buries the ops desk.
  // Over HTTP — closer to production than an in-process test — count what the
  // burst actually created. The assertion is what the mechanism truly
  // guarantees (far below one-per-request), not the exact-once bound the
  // read-then-write collapse cannot promise under simultaneity.
  const burstAlerts = new Set(burst.map((r) => r.json?.data?.id as string).filter(Boolean));
  if (burstAlerts.size >= burstSize / 4) throw new Error(`FAIL: ${burstSize} triggers minted ${burstAlerts.size} distinct alerts — the exempt route is still close to an unbounded mint`);
  log('EVIDENCE SOS exempt from rate limits ABOVE the global ceiling, and the burst does NOT bury ops', { triggers: burstSize, ceiling: CEILING, waveSize: WAVE, rateLimited: 0, unauthorized: 0, allWellFormed: true, distinctAlertsMinted: burstAlerts.size });

  // ── 7. replay is ONE alert — and ONLY for the person who sent it ────────
  const key = `b14-${randomInt(100000, 999999)}`;
  const r1 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, clientIdempotencyKey: key }, token);
  // [F-027-19] Track r1 BEFORE the second call. It used to be pushed after
  // awaiting r2, so a throw in r2 left r1 untracked — and the id-only cleanup
  // then stranded a live alert on the rig even though the run exited red.
  if (r1.json?.data?.id) raised.push(r1.json.data.id);
  const r2 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, clientIdempotencyKey: key }, token);
  if (r1.json.data.id !== r2.json.data.id) throw new Error(`FAIL: replay minted a SECOND alert (${r1.json.data.id} vs ${r2.json.data.id})`);
  log('EVIDENCE replayed trigger returns the original alert', { id: r1.json.data.id });

  // [F-026-17] 7b — the SAME key from a DIFFERENT person is a DIFFERENT
  // emergency. The old lookup was by key alone, so the second caller was
  // handed the first caller's alert id and status: their phone showed "help
  // is coming" while nobody had been paged for them at all.
  const stolen = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, clientIdempotencyKey: key }, otherToken);
  if (stolen.status >= 300) throw new Error(`FAIL: the other actor's SOS was REFUSED (${stolen.status}) because someone else used their key: ${JSON.stringify(stolen.json).slice(0, 200)}`);
  raised.push(stolen.json.data.id);
  if (stolen.json.data.id === r1.json.data.id) throw new Error('FAIL: a second person reusing the key was handed the FIRST person\'s alert — their own emergency was never raised');
  const stolenRow = await prisma.sosAlert.findUniqueOrThrow({ where: { id: stolen.json.data.id }, select: { actorUserId: true } });
  if (stolenRow.actorUserId !== other.id) throw new Error(`FAIL: the second actor's alert is filed against ${stolenRow.actorUserId}, not them`);
  log('EVIDENCE a reused key raises the SECOND person\'s own alert', { mine: r1.json.data.id, theirs: stolen.json.data.id });

  // [F-026-17] 7c — CONCURRENT retries from one device. read-then-create is
  // not atomic: both can miss the read and one loses on the unique index. The
  // loser must receive the winner, never a 500 to someone mid-emergency.
  // The live-alert collapse (F-027-17) runs BEFORE the key lookup, so with an
  // open alert these retries would collapse onto it and never exercise the
  // idempotency path at all — the test would pass while proving nothing.
  // Close what is live first, as rig hygiene, so the race reaches the code it
  // claims to test.
  // Everything live for this actor, including leg 7's own replay alert. The
  // cross-user leg that needed a2 ACTIVE now runs earlier (5b), precisely so
  // this one can start from a clean slate.
  // [F-028-16] Deleted, not force-RESOLVED — same reasoning as leg 1's close.
  const preRaceLive = await prisma.sosAlert.findMany({
    where: { actorUserId: customer.id, status: { in: ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] } },
    select: { id: true },
  });
  await deleteSyntheticAlerts(preRaceLive.map((r) => r.id));
  const raceKey = `b14-race-${randomInt(100000, 999999)}`;
  const raceBody = { lat: 6.8, lng: -58.15, clientIdempotencyKey: raceKey };
  const race = await Promise.all([
    http('POST', '/safety/sos', raceBody, token),
    http('POST', '/safety/sos', raceBody, token),
    http('POST', '/safety/sos', raceBody, token),
  ]);
  race.forEach((r) => { if (r.json?.data?.id) raised.push(r.json.data.id); });
  const raceErrors = race.filter((r) => r.status !== 200);
  if (raceErrors.length > 0) throw new Error(`FAIL: ${raceErrors.length}/3 concurrent retries errored (first ${raceErrors[0]!.status}: ${JSON.stringify(raceErrors[0]!.json).slice(0, 200)})`);
  const raceIds = new Set(race.map((r) => r.json.data.id as string));
  if (raceIds.size !== 1) throw new Error(`FAIL: concurrent retries minted ${raceIds.size} alerts, not 1 (${[...raceIds].join(', ')})`);
  const raceRows = await prisma.sosAlert.count({ where: { clientIdempotencyKey: `client:${raceKey}` } });
  if (raceRows !== 1) throw new Error(`FAIL: ${raceRows} rows carry the raced key — exactly-once did not hold in the DATABASE`);
  log('EVIDENCE concurrent retries settle on ONE alert with no error', { id: [...raceIds][0], rows: raceRows });

  // ── 9. trip share: public, small, revocable ─────────────────────────────
  // A share is only mintable on a LIVE trip (terminal trips 409 TRIP_OVER —
  // itself correct behaviour), so raise one: a PENDING request is non-terminal
  // even with no driver online (B9 proved the honest zero-supply path). The
  // ride is cancelled at the end of the leg.
  const rideReq = await http('POST', '/rides/request', {
    pickup: { lat: 6.8, lng: -58.15 }, dropoff: { lat: 6.82, lng: -58.17 },
    pickupAddress: 'ELV2 B14 share pickup', dropoffAddress: 'ELV2 B14 share dropoff',
    passengerCount: 1, rideClass: 'ECONOMY',
  }, token);
  // [F-026-18] The trip is a MANDATORY fixture. Turning an unraisable ride
  // into a note meant the whole share claim — public view, payload budget,
  // revocation — could be skipped on a run that still printed COMPLETE.
  if (rideReq.status !== 201) throw new Error(`FAIL: could not raise the live trip the share leg REQUIRES (${rideReq.status}): ${JSON.stringify(rideReq.json).slice(0, 200)}`);
  const rideId = rideReq.json.data.ride.id as string;
  // [F-026-19] Registered BEFORE the first fallible call, so the finally-path
  // teardown owns it no matter where the leg dies.
  rides.push(rideId);
  const mint = await http('POST', `/safety/trips/${rideId}/share`, {}, token);
  if (mint.status >= 300) throw new Error(`share mint ${mint.status}: ${JSON.stringify(mint.json).slice(0, 200)}`);
  const shareToken = mint.json?.data?.token ?? mint.json?.data?.shareToken;
  if (!shareToken) throw new Error('FAIL: share mint returned no token');
  const view = await http('GET', `/safety/public/trip/${shareToken}`);
  if (view.status !== 200) throw new Error(`FAIL: public trip view ${view.status} — a shared trip must load WITHOUT auth`);
  if (view.bytes > 300_000) throw new Error(`FAIL: trip-share payload ${view.bytes}B exceeds the 300KB budget`);
  // A size ceiling alone is satisfied by an EMPTY body. The point of the share
  // is that whoever is watching can see the trip, so require it to actually
  // carry one: a rendered status and the person being tracked.
  const shared = view.json?.data;
  if (!shared || typeof shared.status !== 'string' || shared.status.length === 0) throw new Error(`FAIL: the share page carries no trip status — a 200 under the size budget is not a viewable trip: ${JSON.stringify(view.json).slice(0, 200)}`);
  if (!shared.passengerFirstName) throw new Error(`FAIL: the share page names nobody — the watcher cannot tell whose trip this is: ${JSON.stringify(view.json).slice(0, 200)}`);
  const revoke = await http('DELETE', `/safety/share/${shareToken}`, undefined, token);
  if (revoke.status >= 300) throw new Error(`revoke ${revoke.status}`);
  const after = await http('GET', `/safety/public/trip/${shareToken}`);
  if (after.status !== 404) throw new Error(`FAIL: a REVOKED share still resolves (${after.status})`);
  log('EVIDENCE trip share public, carries the trip, within budget, revocable', { payloadBytes: view.bytes, status: shared.status, watching: shared.passengerFirstName, afterRevoke: after.status });

  // [F-026-16] Teardown BEFORE the completion line, and its failure fails the
  // run: a life-safety baseline must not print COMPLETE over live alerts.
  await closeRaised(token);
  log('B14 COMPLETE — SAFETY STATUS STATES ONLY WHAT ACTUALLY HAPPENED (teardown verified clean)');
}

/** Never leave a live SOS or a live ride on the rig — and never CLAIM to have
 *  closed one.
 *  [F-026-16] This is a force-close through raw Prisma: it deliberately
 *  bypasses the ops actor, resolution code, transition table and all-clear
 *  fan-out, because it is rig hygiene, not a real resolution. So it verifies
 *  the END STATE afterwards and throws if anything survived — a swallowed
 *  cleanup error must never ride out on a green exit.
 *  [F-026-19] Rides are torn down HERE, from the finally path, rather than
 *  inline at the end of the happy leg where any earlier throw skipped them. */
/** [F-028-16] The ONE way a synthetic alert leaves this rig: its evidence
 *  first, its incident soft-references next, the row itself LAST — and any
 *  failure aborts BEFORE the alert vanishes. The previous order (swallow the
 *  cleanup errors, delete the alert anyway) orphaned evidence bundles and
 *  dangling incident references that no later alert-based sweep could ever
 *  find again, so a future run misread both rig safety state and retained
 *  evidence. If cleanup fails the alert STAYS, discoverable, and the run
 *  reports the failure instead of hiding it. */
async function deleteSyntheticAlerts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: ids } } });
  await prisma.incidentCase.updateMany({ where: { sosAlertId: { in: ids } }, data: { sosAlertId: null } });
  await prisma.sosAlert.deleteMany({ where: { id: { in: ids } } });
}

async function closeRaised(token?: string) {
  const problems: string[] = [];

  // [F-027-19] DELETE, do not forge a resolution.
  //
  // This used to write every raised alert straight to RESOLVED with a note and
  // no ops actor, no resolution code, no all-clear — a row the product itself
  // could never produce. Its own proof then only checked that no LIVE status
  // remained, so the run could print COMPLETE over semantically invalid,
  // FALSELY RESOLVED alerts sitting in the rig for anything downstream to read
  // as real closures. These are synthetic rows a script invented; the honest
  // end state is that they do not exist, which also makes the check exact
  // (zero rows) instead of an enum test that fabricated data satisfies.
  //
  // Scoped by ACTOR as well as by tracked id: an alert whose POST committed
  // but whose response was lost never enters `raised`, so an id-only sweep
  // would strand it. The two test actors own nothing else on this rig.
  const LIVE = ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] as const;
  const mine = { OR: [{ id: { in: raised } }, ...(actorIds.length ? [{ actorUserId: { in: actorIds } }] : [])] };
  const doomed = await prisma.sosAlert.findMany({ where: mine, select: { id: true, status: true } });
  if (doomed.length > 0) {
    const ids = doomed.map((d) => d.id);
    // [F-028-16] No swallowed failures: the old catch-and-continue deleted the
    // alert even when its evidence cleanup had failed, orphaning bundles and
    // dangling incident references beyond any later alert-based sweep. The
    // helper deletes evidence FIRST and throws before the alert vanishes, so
    // a failure leaves everything discoverable and lands in `problems`.
    try {
      await deleteSyntheticAlerts(ids);
    } catch (err) {
      problems.push(`alert cleanup failed BEFORE deletion — rows left discoverable: ${(err as Error).message}`);
    }
    log('teardown: deleted the alerts this run raised', {
      deleted: doomed.length,
      wereLive: doomed.filter((d) => (LIVE as readonly string[]).includes(d.status)).length,
    });
  }
  const survivors = await prisma.sosAlert.count({ where: mine });
  if (survivors > 0) problems.push(`${survivors} SOS alert(s) from this run survived teardown`);

  if (rides.length > 0) {
    // Product cancel first (the honest path); raw force-close only for
    // whatever it could not move.
    if (token) {
      for (const id of rides) await http('POST', `/rides/${id}/cancel`, { reason: 'ELV2 B14 teardown' }, token).catch(() => undefined);
    }
    // [F-026-19] FAILED is terminal too. Omitting it meant teardown rewrote a
    // genuinely-failed order to CANCELLED — mutating a terminal record and
    // destroying the very outcome a later run would need to read.
    const TERMINAL = ['CANCELLED', 'COMPLETED', 'DELIVERED', 'REFUNDED', 'FAILED'] as const;
    await prisma.order.updateMany({
      where: { id: { in: rides }, status: { notIn: TERMINAL as never } },
      data: { status: 'CANCELLED' },
    });
    const liveRides = await prisma.order.count({ where: { id: { in: rides }, status: { notIn: TERMINAL as never } } });
    if (liveRides > 0) problems.push(`${liveRides} ride(s) left LIVE on the rig`);
  }

  if (problems.length > 0) throw new Error(`TEARDOWN FAILED: ${problems.join('; ')}`);
}

main()
  .catch((e) => { console.error('B14 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    // Safety net for the FAILURE path (the happy path already tore down and
    // verified above). A failure here is itself a failure of the run.
    await closeRaised(teardownToken).catch((e) => {
      console.error('B14 TEARDOWN FAILED:', e.message);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  });
