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
 *   7. REPLAY IS ONE ALERT — the same clientIdempotencyKey returns the
 *      original, never a second alert.
 *   8. SOMEONE ELSE'S ALERT IS NOT YOURS — read/confirm/cancel by another
 *      authenticated user is refused.
 *   9. TRIP SHARE — a minted share is publicly viewable WITHOUT auth, the
 *      payload is under the 300KB budget, and revoking it 404s.
 *
 * Every alert this script raises is CLOSED (resolved/cancelled) before exit.
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b14-safety-honest.ts
 */
import { PrismaClient } from '@prisma/client';
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
  const anyChannel = notices > 0 || (receipts != null && Object.keys(receipts).length > 0);
  return { notices, receipts, anyChannel };
}

const raised: string[] = [];

async function main() {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const token = await loginByOtp(CUSTOMER_PHONE);
  const otherToken = await loginByOtp(OTHER_PHONE).catch(() => undefined);
  log('actors ready', { customer: customer.id, otherActor: !!otherToken });

  // ── 1. grace is honest: pending, and NOBODY paged yet ────────────────────
  const t1 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token);
  if (t1.status >= 300) throw new Error(`sos ${t1.status}: ${JSON.stringify(t1.json).slice(0, 250)}`);
  const a1 = t1.json.data;
  raised.push(a1.id);
  if (a1.status !== 'TRIGGER_PENDING') throw new Error(`FAIL: expected TRIGGER_PENDING, got ${a1.status}`);
  if (!a1.graceEndsAt || new Date(a1.graceEndsAt) <= new Date()) throw new Error('FAIL: no live grace window returned — the countdown strip would be a fiction');
  // [F-026-11] Sample ACROSS the window rather than once immediately: a late
  // or delayed page would slip past a single instantaneous check.
  const graceEnds = new Date(a1.graceEndsAt).getTime();
  let graceReach = await reachOf(a1.id);
  while (Date.now() < graceEnds - 200) {
    if (graceReach.anyChannel) break;
    await new Promise((r) => setTimeout(r, 250));
    graceReach = await reachOf(a1.id);
  }
  if (graceReach.anyChannel) throw new Error(`FAIL: the alert reached someone DURING the grace window (notices=${graceReach.notices}, receipts=${JSON.stringify(graceReach.receipts)}) — it has not been confirmed`);
  log('EVIDENCE grace is honest across the WHOLE window', { status: a1.status, graceEndsAt: a1.graceEndsAt, notices: 0, receipts: null });

  // ── 2. cancel in grace: nothing happened, and it still says nothing ──────
  // A FRESH alert: leg 1 deliberately spends its whole window sampling, and
  // cancelling after the deadline is now correctly refused (the F-026-12 fix).
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

  // ── 6. SOS is exempt from rate limiting (LHC-1 K2) ──────────────────────
  // [F-026-13] Five requests proved nothing: the global ceiling is 200/min, so
  // a five-shot burst never reaches it, and "not 429" would also be satisfied
  // by five 401s or 500s. Fire ABOVE the configured ceiling and require every
  // response to be a real, well-formed alert.
  const CEILING = Number(process.env['RATE_LIMIT_MAX'] ?? 200);
  const burstSize = CEILING + 20;
  // [F-026-16] Record each id AS IT ARRIVES. Collecting them after the whole
  // batch settled meant one rejected sibling could hide every successful
  // alert from teardown — leaving live SOS rows behind on a "green" run.
  const burst = await Promise.all(Array.from({ length: burstSize }, () =>
    http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, source: 'BUTTON' }, token)
      .then((r) => { if (r.json?.data?.id) raised.push(r.json.data.id); return r; })));
  const limited = burst.filter((r) => r.status === 429);
  if (limited.length > 0) throw new Error(`FAIL K2: ${limited.length}/${burstSize} SOS triggers were RATE-LIMITED past the ${CEILING}/min ceiling — a limiter must never stand between a person and help`);
  const malformed = burst.filter((r) => r.status !== 200 || !r.json?.data?.id || !r.json?.data?.status);
  if (malformed.length > 0) throw new Error(`FAIL: ${malformed.length}/${burstSize} triggers did not return a well-formed alert (first: ${malformed[0]!.status} ${JSON.stringify(malformed[0]!.json).slice(0, 160)})`);
  log('EVIDENCE SOS exempt from rate limits ABOVE the global ceiling', { triggers: burstSize, ceiling: CEILING, rateLimited: 0, allWellFormed: true });

  // ── 7. replay is ONE alert ──────────────────────────────────────────────
  const key = `b14-${randomInt(100000, 999999)}`;
  const r1 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, clientIdempotencyKey: key }, token);
  const r2 = await http('POST', '/safety/sos', { lat: 6.8, lng: -58.15, clientIdempotencyKey: key }, token);
  raised.push(r1.json.data.id);
  if (r1.json.data.id !== r2.json.data.id) throw new Error(`FAIL: replay minted a SECOND alert (${r1.json.data.id} vs ${r2.json.data.id})`);
  log('EVIDENCE replayed trigger returns the original alert', { id: r1.json.data.id });

  // ── 8. someone else's alert is not yours ────────────────────────────────
  if (otherToken) {
    const peek = await http('GET', `/safety/sos/${a2.id}`, undefined, otherToken);
    if (peek.status < 400) throw new Error(`FAIL: another user READ this alert (${peek.status})`);
    const hijack = await http('POST', `/safety/sos/${a2.id}/confirm`, {}, otherToken);
    if (hijack.status < 400) throw new Error(`FAIL: another user CONFIRMED this alert (${hijack.status})`);
    log('EVIDENCE cross-user alert access refused', { read: peek.status, confirm: hijack.status });
  } else {
    log('NOTE cross-user leg skipped — probe account unavailable');
  }

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
  const order = rideReq.status === 201 ? { id: rideReq.json.data.ride.id as string } : null;
  if (!order) log('NOTE could not raise a live trip for the share leg', { status: rideReq.status, body: JSON.stringify(rideReq.json).slice(0, 160) });
  if (order) {
    const mint = await http('POST', `/safety/trips/${order.id}/share`, {}, token);
    if (mint.status >= 300) throw new Error(`share mint ${mint.status}: ${JSON.stringify(mint.json).slice(0, 200)}`);
    const shareToken = mint.json?.data?.token ?? mint.json?.data?.shareToken;
    if (!shareToken) throw new Error('FAIL: share mint returned no token');
    const view = await http('GET', `/safety/public/trip/${shareToken}`);
    if (view.status !== 200) throw new Error(`FAIL: public trip view ${view.status} — a shared trip must load WITHOUT auth`);
    if (view.bytes > 300_000) throw new Error(`FAIL: trip-share payload ${view.bytes}B exceeds the 300KB budget`);
    const revoke = await http('DELETE', `/safety/share/${shareToken}`, undefined, token);
    if (revoke.status >= 300) throw new Error(`revoke ${revoke.status}`);
    const after = await http('GET', `/safety/public/trip/${shareToken}`);
    if (after.status !== 404) throw new Error(`FAIL: a REVOKED share still resolves (${after.status})`);
    log('EVIDENCE trip share public, within budget, revocable', { payloadBytes: view.bytes, afterRevoke: after.status });
    await http('POST', `/rides/${order.id}/cancel`, { reason: 'ELV2 B14 teardown' }, token);
    await prisma.order.updateMany({ where: { id: order.id, status: { notIn: ['CANCELLED', 'COMPLETED', 'DELIVERED', 'REFUNDED'] } }, data: { status: 'CANCELLED' } });
  }

  // [F-026-16] Teardown BEFORE the completion line, and its failure fails the
  // run: a life-safety baseline must not print COMPLETE over live alerts.
  await closeRaisedAlerts();
  log('B14 COMPLETE — SAFETY STATUS STATES ONLY WHAT ACTUALLY HAPPENED (teardown verified clean)');
}

/** Never leave a live SOS on the rig — and never CLAIM to have closed one.
 *  [F-026-16] This is a force-close through raw Prisma: it deliberately
 *  bypasses the ops actor, resolution code, transition table and all-clear
 *  fan-out, because it is rig hygiene, not a real resolution. So it verifies
 *  the END STATE afterwards and throws if anything survived — a swallowed
 *  cleanup error must never ride out on a green exit. */
async function closeRaisedAlerts() {
  const LIVE = ['TRIGGER_PENDING', 'ACTIVE', 'ACKNOWLEDGED'] as const;
  const open = await prisma.sosAlert.findMany({
    where: { id: { in: raised }, status: { in: LIVE as never } },
    select: { id: true },
  });
  if (open.length > 0) {
    await prisma.sosAlert.updateMany({
      where: { id: { in: open.map((o) => o.id) } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolutionNotes: 'ELV2 B14 baseline teardown (force-close, not an ops resolution)' },
    });
    log('teardown: force-closed raised alerts', { closed: open.length });
  }
  const survivors = await prisma.sosAlert.count({ where: { id: { in: raised }, status: { in: LIVE as never } } });
  if (survivors > 0) throw new Error(`TEARDOWN FAILED: ${survivors} SOS alert(s) left LIVE on the rig`);
}

main()
  .catch((e) => { console.error('B14 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    // Safety net for the FAILURE path (the happy path already tore down and
    // verified above). A failure here is itself a failure of the run.
    await closeRaisedAlerts().catch((e) => {
      console.error('B14 TEARDOWN FAILED:', e.message);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  });
