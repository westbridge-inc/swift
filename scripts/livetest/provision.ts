// Provision the seeded vendors into an orderable state [SWIFT-081], using the
// kept SUPER_ADMIN + each vendor's own owner session: documents reviewed by the
// admin (a store activates itself when its last checklist document is
// approved) → open + accepting → one category → one item (ST1 gets stock=1, R2
// is pickup-only). Defensive: logs each step's status and continues, so the run
// reports the real reachable state rather than aborting on the first gap.
//
// [TASK-057] provisionJourneyWorld() does the same for the whole journey
// roster over HTTP only: vendor and mover checklists (unique bytes per
// upload), admin review, movers online at their positions, the service
// provider verified, the taxi passenger raised to L2, and leftovers from an
// earlier run healed.

import { randomBytes } from 'node:crypto';
import { login, GET, POST, PUT, req, upload, codeOf, type Session, type Res } from './client.js';
import { ensureSelfies, uniquePng, type Roster } from './roster.js';
import { FICTIONAL_GY, TargetRefused } from './guard.js';
import type { World, WorldItem } from './journeys/context.js';
import { activeLegsOf, customerOrder, riderToDoorFrom, doorOf, startAndSettle, IN_CUSTODY, TERMINAL } from './journeys/common.js';

export interface Item { itemId: string; categoryId: string; price: number }
export interface Provisioned { admin: Session; items: Record<string, Item>; live: string[] }

const ORDERABLE = ['R1', 'R2', 'ST1', 'OV1']; // SERVICE (SV1) needs a licence gate — out of scope

// The open/accepting routes are registered as `/vendor/toggle-*` UNDER the
// `/api/v1/vendor` prefix, so the real path is double-prefixed (the mobile app
// calls it this way; the single-prefix path 404s). They FLIP the flag rather
// than set it, so "ensure true" reads the returned state and toggles again only
// if a prior run had already left it on.
async function ensureFlag(token: string, path: string, field: 'isCurrentlyOpen' | 'acceptingOrders'): Promise<boolean> {
  let r = await PUT(path, {}, token);
  if (r.json?.data?.[field] === false) r = await PUT(path, {}, token);
  return r.json?.data?.[field] === true;
}

export async function provisionVendors(roster: Roster, log: (s: string) => void): Promise<Provisioned> {
  // The seed admin's phone is the operator's (seed-production SEED_ADMIN_PHONE); never a default.
  const adminPhone = requireAdminPhone(process.env.LIVETEST_ADMIN_PHONE);
  const admin = await login(adminPhone);
  const items: Record<string, Item> = {};
  const live: string[] = [];

  for (const id of ORDERABLE) {
    const v = roster.vendors[id];
    if (!v?.vendorId) { log(`  ${id}: no vendorId (become did not return one) — skip`); continue; }

    const docs = await ensureChecklist(admin, v.session, v.vendorType, `${id}`, 'golden-path provisioning', log);
    const opened = await ensureFlag(v.session.token, '/vendor/vendor/toggle-open', 'isCurrentlyOpen');
    const accepting = await ensureFlag(v.session.token, '/vendor/vendor/toggle-orders', 'acceptingOrders');
    const cat = await POST('/vendor/categories', { name: 'Menu', sortOrder: 0 }, v.session.token);
    const categoryId = cat.json?.data?.id ?? cat.json?.data?.category?.id;
    const price = 1500;
    const body: Record<string, unknown> = { categoryId, name: `${id} Plate`, basePrice: price, isAvailable: true };
    if (id === 'ST1') body.stockQuantity = 1;
    if (id === 'R2') body.fulfillment = 'PICKUP';
    const it = categoryId ? await POST('/vendor/items', body, v.session.token) : null;
    const itemId = it?.json?.data?.id ?? it?.json?.data?.item?.id;
    if (itemId) { items[id] = { itemId, categoryId, price }; live.push(id); }
    log(`  ${id}: docs=${docs} open=${opened} accepting=${accepting} cat=${cat.status} item=${it?.status ?? '-'}${itemId ? ' ✓' : ''}`);
  }

  return { admin, items, live };
}

/** LIVETEST_ADMIN_PHONE, required and never-a-subscriber (+5920…); refuses like run.ts does. */
export function requireAdminPhone(raw: string | undefined): string {
  const phone = (raw ?? '').trim();
  if (!FICTIONAL_GY.test(phone)) {
    throw new TargetRefused('p', 'LIVETEST_ADMIN_PHONE must name the seed admin: a never-a-subscriber +5920 number (staging: +5920400000)');
  }
  return phone;
}

// ── [TASK-057] shared provisioning ───────────────────────────────────────────

/** Types that expire: an admin must approve them with an expiresAt (doc-registry.ts). */
const EXPIRING = new Set([
  'police_clearance', 'fitness_cert', 'vehicle_insurance', 'hire_car_permit', 'road_service_licence',
  'drivers_licence', 'vehicle_registration', 'food_handler_cert', 'gra_restaurant_licence', 'self_declaration_unregistered',
]);
const PRIVACY_NOTICE_VERSION = '2026-09-23'; // modules/legal/legal.routes.ts LEGAL_VERSION

let reasonSeq = 0;
/** ADM-006: consequential admin actions carry a stated reason (12–500 chars, not a template). */
export const adminReason = (what: string) => `journey runner check ${++reasonSeq}: ${what}`.slice(0, 480);
export const asAdmin = (token: string, what: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
  req(method, path, { token, body: body ?? {}, headers: { 'x-swift-reason': adminReason(what), ...extra } });

/** A unique, well-formed PDF (the server sniffs %PDF-); unique bytes keep accounts apart in the identity graph. */
export function uniquePdf(label: string): Buffer {
  const nonce = randomBytes(12).toString('hex');
  return Buffer.from(
    `%PDF-1.4\n% synthetic journey document ${label} ${nonce}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj ` +
    `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]/Parent 2 0 R>>endobj\n` +
    `trailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
}

/** Upload one document file; returns the private object URL. */
export async function uploadDoc(owner: Session, label: string): Promise<{ url?: string; res: Res }> {
  const res = await upload('/verification/upload', owner.token, { name: `${label}.pdf`, type: 'application/pdf', bytes: uniquePdf(label) });
  return { url: res.json?.data?.url, res };
}

/** Upload + submit one checklist document; returns the new document id. */
export async function submitDoc(owner: Session, role: string, docType: string, label: string): Promise<{ id?: string; res: Res }> {
  const up = await uploadDoc(owner, `${label}-${docType}`);
  if (!up.url) return { res: up.res };
  const res = await POST('/verification/documents', { role, docType, fileUrl: up.url, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION }, owner.token);
  return { id: res.json?.data?.id, res };
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

/** Approve one pending document as the admin (with an expiry, and hire insurance for a taxi). */
export async function approveDoc(admin: Session, docId: string, docType: string, vehicleType?: string): Promise<Res> {
  const body: Record<string, unknown> = {};
  if (EXPIRING.has(docType)) body.expiresAt = inDays(300);
  if (docType === 'vehicle_insurance' && vehicleType && ['CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15'].includes(vehicleType)) {
    body.insurance = { insurerName: 'Synthetic Assurance', policyNumber: `SYN-${docId.slice(-8)}`, coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true };
  }
  return asAdmin(admin.token, `approve synthetic ${docType} submitted by the journey roster`, 'PUT', `/admin/verification/${docId}/approve`, body);
}

/**
 * Bring one partner's checklist to fully approved: submit what is missing,
 * approve what is pending. `role` is the checklist role (MOVER, RESTAURANT,
 * STORE, SUPERMARKET, SERVICE_PROVIDER). Returns a short state string.
 */
export async function ensureChecklist(admin: Session, owner: Session, role: string, label: string, _why: string, log: (s: string) => void, vehicleType?: string): Promise<string> {
  const q = `/verification/status?role=${role}${vehicleType ? `&vehicleType=${vehicleType}` : ''}`;
  let st = (await GET(q, owner.token)).json?.data;
  if (!st) return 'status-unreadable';
  if (st.roleVerified) return 'verified';
  const docs: any[] = st.documents ?? [];
  const live = (t: string) => docs.find((d) => d.docType === t && ['APPROVED', 'PENDING'].includes(d.status));
  for (const docType of (st.missing ?? []) as string[]) {
    if (live(docType)) continue;
    const s = await submitDoc(owner, role, docType, label);
    if (!s.id) log(`    ${label}: submit ${docType} → ${s.res.status} ${codeOf(s.res)} ${s.res.text.slice(0, 160)}`);
  }
  st = (await GET(q, owner.token)).json?.data;
  for (const d of (st?.documents ?? []) as any[]) {
    if (d.status !== 'PENDING') continue;
    const a = await approveDoc(admin, d.id, d.docType, vehicleType);
    if (!a.ok) log(`    ${label}: approve ${d.docType} → ${a.status} ${codeOf(a)} ${a.text.slice(0, 160)}`);
  }
  st = (await GET(q, owner.token)).json?.data;
  return st?.roleVerified ? 'verified' : `missing=${JSON.stringify(st?.missing ?? [])}`;
}

/**
 * The store behind GET /vendor/profile. The route answers the OWNER record
 * ({ id: ownerId, userId, vendors: [...], myRole }), so a store's status,
 * flags and verification live on its row in `vendors`: by id when given,
 * else the first (an owner minted by the runner has exactly one).
 */
export function vendorOf(json: any, vendorId?: string): any {
  const d = json?.data;
  const rows: any[] = Array.isArray(d?.vendors) ? d.vendors : d?.vendor ? [d.vendor] : d?.status !== undefined ? [d] : [];
  return (vendorId ? rows.find((r) => r?.id === vendorId) : undefined) ?? rows[0];
}

async function ensureCategory(owner: Session, name: string): Promise<string | undefined> {
  const cats = await GET('/vendor/categories', owner.token);
  const found = (cats.json?.data ?? []).find((c: any) => c.name === name);
  if (found) return found.id;
  const c = await POST('/vendor/categories', { name, sortOrder: 0 }, owner.token);
  return c.json?.data?.id ?? c.json?.data?.category?.id;
}

/** Find an item by name or create it; reset price, availability and (optionally) stock. */
async function ensureItem(owner: Session, categoryId: string, name: string, price: number, extra: Record<string, unknown> = {}): Promise<WorldItem | undefined> {
  const list = await GET('/vendor/items?limit=50', owner.token);
  const rows: any[] = Array.isArray(list.json?.data) ? list.json.data : list.json?.data?.items ?? [];
  const found = rows.find((i) => i.name === name);
  if (found) {
    await PUT(`/vendor/items/${found.id}`, { basePrice: price, isAvailable: true, ...extra }, owner.token);
    return { itemId: found.id, categoryId, price, name };
  }
  const it = await POST('/vendor/items', { categoryId, name, basePrice: price, isAvailable: true, ...extra }, owner.token);
  const itemId = it.json?.data?.id ?? it.json?.data?.item?.id;
  return itemId ? { itemId, categoryId, price, name } : undefined;
}

const MENU: Record<string, Array<{ key: string; name: string; price: number; extra?: Record<string, unknown> }>> = {
  R1: [{ key: 'R1', name: 'R1 Plate', price: 1500 }, { key: 'R1-feast', name: 'R1 Feast Box', price: 4500 }],
  R2: [{ key: 'R2', name: 'R2 Plate', price: 1500 }],
  R3: [{ key: 'R3', name: 'R3 Plate', price: 1500 }],
  ST1: [{ key: 'ST1', name: 'ST1 Last Bag', price: 1500, extra: { stockQuantity: 1 } }],
  OV1: [
    { key: 'OV1', name: 'OV1 Item', price: 1200 },
    { key: 'OV1-spare', name: 'OV1 Spare', price: 900 },
    { key: 'OV1-drift', name: 'OV1 Drift', price: 700 },
  ],
};

/** A mover's position, reported the way the app does it. */
export async function ping(m: { kind: 'rider' | 'driver'; session: Session; lat: number; lng: number }): Promise<Res> {
  return PUT(`/${m.kind}/location`, { latitude: m.lat, longitude: m.lng, accuracy: 8 }, m.session.token);
}

export async function goOnline(m: { kind: 'rider' | 'driver'; session: Session; lat: number; lng: number }): Promise<Res> {
  return POST(`/${m.kind}/go-online`, { latitude: m.lat, longitude: m.lng }, m.session.token);
}

export async function goOffline(m: { kind: 'rider' | 'driver'; session: Session }): Promise<Res> {
  return POST(`/${m.kind}/go-offline`, {}, m.session.token);
}

/**
 * End whatever a previous (interrupted) run left live, so this run starts clean.
 *
 * Movers first. A job already in a mover's hands (IN_CUSTODY) cannot be
 * cancelled by anyone — the state machine lets it end only DELIVERED or FAILED —
 * so it is finished the way a mover finishes it: walked to the door and closed
 * paid, with the customer's door PIN. Anything short of custody is cancelled by
 * the operator. The count is of what actually ended; what could not is named.
 */
async function heal(roster: Roster, admin: Session, log: (s: string) => void): Promise<void> {
  const tally = { cancelled: 0, finished: 0 };
  const stuck: string[] = [];
  const seen = new Set<string>(); // [DS230 F4] each leftover is attempted, and named, once
  const settle = (what: string, r: Res, kind: 'cancelled' | 'finished') => { if (r.ok) tally[kind] += 1; else stuck.push(`${what} → ${r.status} ${codeOf(r)}`); };
  const operatorCancel = (id: string) => asAdmin(admin.token, 'reset a mover job left by an interrupted journey run', 'PUT', `/admin/orders/${id}/cancel`, { reason: 'journey runner reset of an interrupted run' });
  const accounts = [...Object.values(roster.customers), ...Object.values(roster.providers ?? {})];
  // The door PIN reaches only the customer who placed the order (GET /customer/orders/:id).
  const doorPin = async (orderId: string): Promise<string | null> => {
    for (const c of accounts) {
      const pin = (await customerOrder(c.session, orderId))?.ridePin;
      if (typeof pin === 'string' && pin) return pin;
    }
    return null;
  };

  for (const m of Object.values(roster.movers)) {
    if (m.kind === 'rider') {
      for (const o of activeLegsOf((await GET('/rider/orders/active-legs', m.session.token)).json)) {
        seen.add(o.id);
        const what = `${m.id} ${o.orderType ?? 'order'} ${o.id} (${o.status})`;
        if (!IN_CUSTODY.includes(o.status)) { settle(what, await operatorCancel(o.id), 'cancelled'); continue; }
        // [DS230 F3] The door handover closes CASH only; an MMG leg would be
        // walked to the door for nothing. Name it, and leave it untouched.
        if (o.paymentMethod !== 'CASH') { stuck.push(`${what}: ${o.paymentMethod} in custody — not a cash handover`); continue; }
        const courier = o.orderType === 'COURIER'; // settles from any custody state; no door PIN
        const walked = courier ? null : await riderToDoorFrom(m.session, o.id, o.status);
        if (walked && !walked.ok) { settle(`${what} walking to the door`, walked, 'finished'); continue; }
        const pin = courier ? null : await doorPin(o.id);
        settle(what, await POST(`/rider/orders/${o.id}/handover`, { outcome: 'paid', gps: doorOf(o, m), ...(pin ? { ridePin: pin } : {}) }, m.session.token), 'finished');
      }
      await PUT('/rider/profile', { riderType: 'BOTH' }, m.session.token);
    } else {
      for (const ride of activeLegsOf((await GET('/driver/rides/active', m.session.token)).json)) {
        seen.add(ride.id);
        const what = `${m.id} ride ${ride.id} (${ride.status})`;
        if (!IN_CUSTODY.includes(ride.status)) {
          const cancel = await operatorCancel(ride.id);
          // [DS230 F2] DRIVER_ARRIVED with the PIN verified is passenger
          // custody: the cancel is refused, so the driver starts and settles it.
          if (!cancel.ok && ride.status === 'DRIVER_ARRIVED') settle(what, await startAndSettle(m.session, ride.id, doorOf(ride, m)), 'finished');
          else settle(what, cancel, 'cancelled');
          continue;
        }
        settle(what, await POST(`/driver/rides/${ride.id}/handover`, { outcome: 'paid', gps: doorOf(ride, m) }, m.session.token), 'finished');
      }
    }
  }

  for (const c of accounts) {
    const live = await GET('/customer/orders?live=true&limit=50', c.session.token);
    for (const o of (live.json?.data ?? []) as any[]) {
      if (TERMINAL.includes(o.status) || seen.has(o.id)) continue;
      const cancel = await POST(`/customer/orders/${o.id}/cancel`, { reason: 'journey runner reset' }, c.session.token);
      settle(`${c.id} order ${o.id} (${o.status})`, cancel.ok ? cancel : await operatorCancel(o.id), 'cancelled');
    }
    const ride = (await GET('/rides/active', c.session.token)).json?.data;
    if (ride?.id && !TERMINAL.includes(ride.status) && !seen.has(ride.id)) {
      const cancel = await POST(`/rides/${ride.id}/cancel`, { reason: 'journey runner reset' }, c.session.token);
      settle(`${c.id} ride ${ride.id} (${ride.status})`, cancel.ok ? cancel : await operatorCancel(ride.id), 'cancelled');
    }
    const q = await GET('/rides/queue', c.session.token);
    if (q.json?.data) await POST('/rides/queue/leave', {}, c.session.token);
  }
  log(`  leftovers from earlier runs: ${tally.cancelled} cancelled, ${tally.finished} finished at the door${stuck.length ? `; STILL LIVE: ${stuck.join('; ')}` : ''}`);
}

/** The whole journey world, over HTTP. Never throws for one partner's gap: it is recorded in `notReady`. */
export async function provisionJourneyWorld(roster: Roster, admin: Session, log: (s: string) => void): Promise<World> {
  const world: World = { items: {}, liveVendors: [], readyMovers: [], onlineMovers: [], notReady: {}, providers: {} };
  await ensureSelfies(roster, log);
  await heal(roster, admin, log);

  for (const v of Object.values(roster.vendors)) {
    if (!v.vendorId) { world.notReady[v.id] = 'partner/become returned no vendor id'; continue; }
    const docs = await ensureChecklist(admin, v.session, v.vendorType, v.id, 'vendor', log);
    let prof = vendorOf((await GET('/vendor/profile', v.session.token)).json, v.vendorId);
    if (prof?.status === 'SUSPENDED' && docs === 'verified') {
      await asAdmin(admin.token, 'reinstate a synthetic store suspended by an earlier journey run', 'PUT', `/admin/vendors/${v.vendorId}/approve`);
      prof = vendorOf((await GET('/vendor/profile', v.session.token)).json, v.vendorId);
    }
    const open = await ensureFlag(v.session.token, '/vendor/vendor/toggle-open', 'isCurrentlyOpen');
    const accepting = await ensureFlag(v.session.token, '/vendor/vendor/toggle-orders', 'acceptingOrders');
    const categoryId = await ensureCategory(v.session, 'Menu');
    for (const m of MENU[v.id] ?? []) {
      const it = categoryId ? await ensureItem(v.session, categoryId, m.name, m.price, m.extra) : undefined;
      if (it) world.items[m.key] = it;
    }
    const ok = prof?.status === 'ACTIVE' && open && accepting && !!world.items[v.id];
    if (ok) world.liveVendors.push(v.id);
    else world.notReady[v.id] = `docs=${docs} status=${prof?.status} open=${open} accepting=${accepting} item=${!!world.items[v.id]}`;
    log(`  ${v.id}: docs=${docs} status=${prof?.status} open=${open} accepting=${accepting} items=${(MENU[v.id] ?? []).filter((m) => world.items[m.key]).length}${ok ? ' ✓' : ''}`);
  }

  for (const m of Object.values(roster.movers)) {
    const docs = await ensureChecklist(admin, m.session, 'MOVER', m.id, 'mover', log, m.vehicleType);
    if (docs !== 'verified') { world.notReady[m.id] = `documents ${docs}`; log(`  ${m.id}: ${docs}`); continue; }
    world.readyMovers.push(m.id);
    const on = await goOnline(m);
    if (on.ok) {
      await ping(m);
      world.onlineMovers.push(m.id);
    } else {
      world.notReady[m.id] = `go-online → ${on.status} ${codeOf(on)}`;
    }
    log(`  ${m.id} (${m.vehicleType}): docs=${docs} online=${on.ok ? 'yes' : `${on.status} ${codeOf(on)}`}`);
  }

  for (const p of Object.values(roster.providers ?? {})) {
    const prof = await POST('/services/providers', { trade: p.trade, bio: 'Synthetic journey provider' }, p.session.token);
    const docs = await ensureChecklist(admin, p.session, 'SERVICE_PROVIDER', p.id, 'provider', log);
    const me = (await GET('/services/providers/me', p.session.token)).json?.data;
    world.providers[p.id] = me?.id ?? prof.json?.data?.id;
    if (!me?.isVerified) world.notReady[p.id] = `provider docs=${docs} verified=${me?.isVerified}`;
    log(`  ${p.id}: provider ${world.providers[p.id] ? 'present' : 'missing'} docs=${docs} verified=${me?.isVerified}`);
  }

  // The taxi passenger: every ride needs an L2 account (rides.service.ts).
  const c7 = roster.customers.C7;
  if (c7) {
    const me = (await GET('/verification/status?role=MOVER', c7.session.token)).json?.data;
    if (me?.trustLevel !== 'L2' && me?.trustLevel !== 'L3') {
      const idDoc = await uploadDoc(c7.session, 'C7-national-id');
      const face = await upload('/verification/upload', c7.session.token, { name: 'face.png', type: 'image/png', bytes: uniquePng('C7-identity') });
      const idv = await POST('/verification/identity', { idDocumentUrl: idDoc.url, selfieUrl: face.json?.data?.url, consent: true, privacyNoticeVersion: PRIVACY_NOTICE_VERSION }, c7.session.token);
      const docId = idv.json?.data?.id;
      if (docId) await asAdmin(admin.token, 'approve the synthetic identity check of the taxi journey passenger', 'PUT', `/admin/verification/${docId}/approve`, {});
      else if (idv.status !== 409) log(`  C7: identity → ${idv.status} ${codeOf(idv)} ${idv.text.slice(0, 160)}`);
    }
    const after = (await GET('/verification/status?role=MOVER', c7.session.token)).json?.data;
    if (after?.trustLevel !== 'L2' && after?.trustLevel !== 'L3') world.notReady.C7 = `trustLevel=${after?.trustLevel}`;
    log(`  C7: trustLevel=${after?.trustLevel}`);
  }
  return world;
}

/** Keep online movers' positions fresh (offers need ≤90 s); returns a stop function. */
export function startHeartbeat(roster: Roster, world: World, overrides: Record<string, { lat: number; lng: number } | null>): () => void {
  let stopped = false;
  const beat = async () => {
    for (const id of world.onlineMovers) {
      if (stopped) return;
      const m = roster.movers[id];
      if (!m) continue;
      const pos = overrides[id];
      if (pos === null) continue; // deliberately paused (a journey is proving staleness)
      await ping({ ...m, ...(pos ?? {}) }).catch(() => undefined);
    }
  };
  const timer = setInterval(() => { void beat(); }, 30_000);
  return () => { stopped = true; clearInterval(timer); };
}

/** End of run: every mover offline (a job still in hand is reported, never forced). */
export async function moversOffline(roster: Roster, world: World, log: (s: string) => void): Promise<void> {
  const left: string[] = [];
  for (const id of world.readyMovers) {
    const m = roster.movers[id];
    if (!m) continue;
    const r = await goOffline(m);
    if (!r.ok && r.status !== 400) left.push(`${id} ${r.status} ${codeOf(r)}`);
  }
  log(`  movers offline${left.length ? ` (still busy: ${left.join(', ')})` : ''}`);
}
