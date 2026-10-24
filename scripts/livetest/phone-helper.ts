// The phone-test counterpart helper [PHONE-HELPER] — staging only.
//
// The owner tests the Phones-gate journeys holding ONE iPhone (build 8). Most
// journeys need a second party: the store that accepts his order, the rider
// who brings it, the driver who picks him up, the customer whose order his
// store takes, the courier who carries his parcel, the provider who quotes his
// job. This helper plays those parties as the journeys roster's TEST ACCOUNTS
// (+5920… numbers no subscriber can hold), through the REAL API of the private
// journeys instance (api-journeys: the same image, database and worker as the
// public API the phone talks to). Every action is an HTTP call as that
// account. There is no database access, no admin shortcut and no test-control
// write: the only call that is not an actor's own is the target guard's
// identity probe.
//
// The same guard as the journeys suite (guard.ts), before the first action:
//   p  every account it can sign in, and the seed admin that proves the
//      target, is +5920… (never a real person);
//   a  the target resolves to a private address, never the public host;
//   b  /test-control/identity answers (the private instance) and is not
//      production (and matches LIVETEST_EXPECT_* pins when set);
//   c  the database's data classification is synthetic.
// deploy/phone-helper.sh adds the host half: the staging pilot only, the
// checked-out revision everywhere, the isolation contract, and the public
// route proofs — the checks journeys-run.sh makes.
//
// Usage (inside the journeys runner; deploy/phone-helper.sh wraps it):
//   <role> <action> [--as <roster id>] [--order <id>] [--store <id>] [--job <id>]
//          [--at <lat,lng>] [--to <lat,lng>] [--pin <digits>] [--code <6 digits>]
//          [--amount <GYD>] [--item <id>] [--outcome paid|no_show] [--pickup] [--wait <s>]
// Exit: 0 done · 1 the API refused a step (the line says which) · 2 usage · 3 target refused.

import { ORIGIN, GET, POST, PUT, login, upload, sleep as realSleep, type Res, type Session } from './client.js';
import { refusePublicTarget, refuseUnsafeIdentity, refuseLivePhones, TargetRefused } from './guard.js';
import { RECIPIENT_PHONE, uniquePng } from './roster.js';
import { requireAdminPhone } from './provision.js';
import { activeLegsOf, codeOf, clearCart, idemKey, orderIdsOf, req } from './journeys/common.js';

export type Role = 'customer' | 'store' | 'rider' | 'driver' | 'courier' | 'provider' | 'all';

export interface Actor { id: string; phone: string; lat: number; lng: number; roles: Role[]; kind?: 'rider' | 'driver' }

/**
 * The accounts the helper may play: journeys roster accounts only, copied here
 * so this tool never edits the roster (staging-drill work does); the test pins
 * every phone to roster.ts fixturePhones(). Home = the roster position.
 */
export const ACTORS: Record<string, Actor> = {
  C4: { id: 'C4', phone: '+5920401004', lat: 6.8045, lng: -58.1633, roles: ['customer'] },
  C6: { id: 'C6', phone: '+5920401006', lat: 6.8150, lng: -58.1445, roles: ['customer'] },
  C7: { id: 'C7', phone: '+5920401007', lat: 6.8110, lng: -58.1530, roles: ['customer'] }, // L2 (identity-reviewed): taxi requests need it
  C8: { id: 'C8', phone: '+5920401008', lat: 6.8140, lng: -58.1540, roles: ['customer'] }, // the courier sender
  R1: { id: 'R1', phone: '+5920402011', lat: 6.8090, lng: -58.1520, roles: ['store'] },
  R2: { id: 'R2', phone: '+5920402012', lat: 6.8210, lng: -58.1440, roles: ['store'] },
  DR1: { id: 'DR1', phone: '+5920403051', lat: 6.8100, lng: -58.1515, roles: ['rider', 'courier'], kind: 'rider' },
  DR2: { id: 'DR2', phone: '+5920403052', lat: 6.8175, lng: -58.1470, roles: ['rider', 'courier'], kind: 'rider' },
  DR3: { id: 'DR3', phone: '+5920403053', lat: 6.7960, lng: -58.1630, roles: ['rider', 'courier'], kind: 'rider' },
  DR4: { id: 'DR4', phone: '+5920403054', lat: 6.8095, lng: -58.1525, roles: ['rider', 'courier'], kind: 'rider' },
  T1: { id: 'T1', phone: '+5920403061', lat: 6.8050, lng: -58.1640, roles: ['driver'], kind: 'driver' },
  T2: { id: 'T2', phone: '+5920403062', lat: 6.8120, lng: -58.1560, roles: ['driver'], kind: 'driver' },
  T3: { id: 'T3', phone: '+5920403063', lat: 6.8300, lng: -58.1380, roles: ['driver'], kind: 'driver' },
  SP1: { id: 'SP1', phone: '+5920404071', lat: 6.8105, lng: -58.1505, roles: ['provider'] },
};

/** Who plays each role unless --as says otherwise. Taxi rides need C7 (L2); courier sends are C8's. */
export const DEFAULT_ACTOR: Record<Exclude<Role, 'all'>, string> = { customer: 'C4', store: 'R1', rider: 'DR2', driver: 'T2', courier: 'DR3', provider: 'SP1' };
const DEFAULT_FOR_ACTION: Record<string, string> = { 'customer ride': 'C7', 'customer ride-pin': 'C7', 'customer cancel-ride': 'C7', 'customer send': 'C8' };

export const ACTIONS: Record<Role, readonly string[]> = {
  customer: ['order', 'codes', 'cancel', 'ride', 'ride-pin', 'cancel-ride', 'send'],
  store: ['open', 'orders', 'accept', 'ready', 'handover', 'close'],
  rider: ['accept', 'pickup', 'deliver', 'offline'],
  driver: ['accept', 'arrive', 'start', 'finish', 'offline'],
  courier: ['accept', 'collect', 'deliver', 'offline'],
  provider: ['jobs', 'quote', 'confirm', 'complete'],
  all: ['status', 'cleanup'],
};

/** What each action needs, so a missing value is a usage error before anything connects. */
const NEEDS: Record<string, Array<'order' | 'store' | 'job' | 'at' | 'to' | 'pin' | 'code' | 'amount'>> = {
  'customer order': ['store'], 'customer codes': ['order'], 'customer cancel': ['order'],
  'customer ride': ['at', 'to'], 'customer ride-pin': ['order'], 'customer cancel-ride': ['order'], 'customer send': ['at', 'to'],
  'store ready': ['order'], 'store handover': ['order', 'code'],
  'rider pickup': ['order'], 'rider deliver': ['order', 'pin'],
  'driver arrive': ['order'], 'driver start': ['order', 'pin'], 'driver finish': ['order'],
  'courier collect': ['order'], 'courier deliver': ['order'],
  'provider quote': ['job', 'amount'], 'provider confirm': ['job'], 'provider complete': ['job'],
};

export interface Point { lat: number; lng: number }
export interface HelperCommand {
  role: Role;
  action: string;
  as: string;
  order?: string;
  store?: string;
  job?: string;
  item?: string;
  at?: Point;
  to?: Point;
  pin?: string;
  code?: string;
  amount?: number;
  outcome: 'paid' | 'no_show';
  pickup: boolean;
  waitSeconds: number;
}

export class HelperUsage extends Error {
  override readonly name = 'HelperUsage';
}

/** An id the API issues (cuid): the only shape an --order / --store / --job / --item takes. */
const ID = /^[a-z0-9]{20,40}$/;
/** A coarse box around Guyana: catches swapped or mistyped coordinates before a mover is sent there. */
const IN_GUYANA = (p: Point) => p.lat >= 1 && p.lat <= 9 && p.lng >= -62 && p.lng <= -56;

function point(raw: string, flag: string): Point {
  const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) throw new HelperUsage(`--${flag} takes <lat,lng> in decimal degrees (e.g. 6.8013,-58.1551)`);
  const p = { lat: Number(m[1]), lng: Number(m[2]) };
  if (!IN_GUYANA(p)) throw new HelperUsage(`--${flag} ${raw} is not in Guyana (lat 1..9, lng -62..-56): check the order of lat and lng`);
  return p;
}

/** Parse and validate one command. Nothing connects before this passes. */
export function parseHelperArgs(argv: readonly string[]): HelperCommand {
  const [role, action, ...rest] = argv;
  if (!role || !Object.prototype.hasOwnProperty.call(ACTIONS, role)) {
    throw new HelperUsage(`name a role: ${Object.keys(ACTIONS).join(' | ')}`);
  }
  const r = role as Role;
  if (!action || !ACTIONS[r].includes(action)) throw new HelperUsage(`${role} actions: ${ACTIONS[r].join(' | ')}`);
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new HelperUsage(`unexpected argument ${JSON.stringify(a)}`);
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (k === 'pickup') { flags[k] = true; continue; }
    const v = inline ?? rest[i + 1];
    if (inline === undefined) i += 1;
    if (v === undefined || v.startsWith('--')) throw new HelperUsage(`--${k} needs a value`);
    if (Object.prototype.hasOwnProperty.call(flags, k)) throw new HelperUsage(`--${k} is given twice`);
    flags[k] = v;
  }
  const known = new Set(['as', 'order', 'store', 'job', 'item', 'at', 'to', 'pin', 'code', 'amount', 'outcome', 'pickup', 'wait']);
  for (const k of Object.keys(flags)) if (!known.has(k)) throw new HelperUsage(`unknown flag --${k}`);
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);

  const as = str('as') ?? DEFAULT_FOR_ACTION[`${role} ${action}`] ?? (r === 'all' ? 'ALL' : DEFAULT_ACTOR[r]);
  if (r !== 'all') {
    const actor = ACTORS[as];
    if (!actor || !actor.roles.includes(r)) throw new HelperUsage(`--as ${as} is not a ${role} the helper may play (${Object.values(ACTORS).filter((a) => a.roles.includes(r)).map((a) => a.id).join(', ')})`);
  } else if (str('as') !== undefined) {
    throw new HelperUsage('"all" acts on every helper account; --as does not apply');
  }
  for (const k of ['order', 'store', 'job', 'item'] as const) {
    const v = str(k);
    if (v !== undefined && !ID.test(v)) throw new HelperUsage(`--${k} ${JSON.stringify(v)} is not an id the API issues`);
  }
  const pin = str('pin');
  if (pin !== undefined && !/^\d{4,6}$/.test(pin)) throw new HelperUsage('--pin is the 4–6 digits the other party reads out');
  const code = str('code');
  if (code !== undefined && !/^\d{6}$/.test(code)) throw new HelperUsage('--code is the 6-digit pickup code');
  const amountRaw = str('amount');
  const amount = amountRaw === undefined ? undefined : Number(amountRaw);
  if (amount !== undefined && !(Number.isInteger(amount) && amount >= 1 && amount <= 10_000_000)) throw new HelperUsage('--amount is whole Guyana dollars, 1 to 10,000,000');
  const outcome = str('outcome') ?? 'paid';
  if (outcome !== 'paid' && outcome !== 'no_show') throw new HelperUsage('--outcome is paid or no_show');
  const waitRaw = str('wait') ?? '300';
  const waitSeconds = Number(waitRaw);
  if (!(Number.isInteger(waitSeconds) && waitSeconds >= 5 && waitSeconds <= 1800)) throw new HelperUsage('--wait is whole seconds, 5 to 1800');

  const cmd: HelperCommand = {
    role: r, action, as,
    ...(str('order') ? { order: str('order') } : {}),
    ...(str('store') ? { store: str('store') } : {}),
    ...(str('job') ? { job: str('job') } : {}),
    ...(str('item') ? { item: str('item') } : {}),
    ...(str('at') ? { at: point(str('at')!, 'at') } : {}),
    ...(str('to') ? { to: point(str('to')!, 'to') } : {}),
    ...(pin ? { pin } : {}),
    ...(code ? { code } : {}),
    ...(amount !== undefined ? { amount } : {}),
    outcome, pickup: flags['pickup'] === true, waitSeconds,
  };
  for (const need of NEEDS[`${role} ${action}`] ?? []) {
    if (cmd[need] === undefined) throw new HelperUsage(`${role} ${action} needs --${need}`);
  }
  return cmd;
}

/** Every phone the helper can sign in, for gate p. */
export function helperPhones(): string[] {
  return [...Object.values(ACTORS).map((a) => a.phone), RECIPIENT_PHONE];
}

export interface HelperDeps {
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface HelperResult { ok: boolean; summary: string; details: Record<string, unknown> }

const done = (summary: string, details: Record<string, unknown> = {}): HelperResult => ({ ok: true, summary, details });
const refused = (step: string, r: Res, details: Record<string, unknown> = {}): HelperResult =>
  ({ ok: false, summary: `${step}: the API answered ${r.status}${codeOf(r) ? ` ${codeOf(r)}` : ''} ${String(r.json?.error?.message ?? r.text ?? '').slice(0, 160)}`.trim(), details });

interface Signed extends Actor { session: Session }
const signIn = async (id: string): Promise<Signed> => ({ ...ACTORS[id]!, session: await login(ACTORS[id]!.phone) });
const mover = (a: Signed, at?: Point) => ({ kind: a.kind!, session: a.session, lat: at?.lat ?? a.lat, lng: at?.lng ?? a.lng });

/** How often a waiting mover reports its position (dispatch skips stale movers), and how often it polls. */
export const PING_EVERY_MS = 10_000;
export const POLL_EVERY_MS = 2_000;
/** PUT /driver/location persists one fix per 10 s: a refused arrival is retried once past that. */
const LOCATION_DEBOUNCE_MS = 11_000;

const listOf = (json: any): any[] => {
  const d = json?.data;
  if (Array.isArray(d)) return d;
  for (const k of ['orders', 'items', 'jobs', 'rows']) if (Array.isArray(d?.[k])) return d[k];
  return [];
};

// ── movers ──────────────────────────────────────────────────────────────────

/** Online at `at` (or home), position kept fresh, until an offer (for `orderId`, if given) arrives; then accept it. */
async function acceptOffer(a: Signed, cmd: HelperCommand, deps: HelperDeps): Promise<HelperResult> {
  const m = mover(a, cmd.at);
  const on = await POST(`/${m.kind}/go-online`, { latitude: m.lat, longitude: m.lng }, m.session.token);
  if (!on.ok && codeOf(on) !== 'ALREADY_ONLINE') return refused(`${a.id} go online`, on);
  deps.log(`${a.id} is online at ${m.lat},${m.lng} and waiting up to ${cmd.waitSeconds} s for ${cmd.order ? `the offer for ${cmd.order}` : 'an offer'}…`);
  const deadline = deps.now() + cmd.waitSeconds * 1000;
  let lastPing = -Infinity;
  while (deps.now() < deadline) {
    if (deps.now() - lastPing >= PING_EVERY_MS) {
      await PUT(`/${m.kind}/location`, { latitude: m.lat, longitude: m.lng, accuracy: 8 }, m.session.token);
      lastPing = deps.now();
    }
    const r = await GET(`/${m.kind}/offers/current`, m.session.token);
    const offer = r.json?.data?.offer ?? (r.json?.data?.orderId ? r.json.data : null);
    if (offer?.orderId && (!cmd.order || offer.orderId === cmd.order)) {
      const acc = await POST(`/${m.kind}/offers/accept`, { orderId: offer.orderId, offerAttemptId: offer.offerAttemptId }, m.session.token);
      if (!acc.ok) return refused(`${a.id} accept the offer for ${offer.orderId}`, acc);
      return done(`${a.id} accepted ${offer.orderId}${offer.orderNumber ? ` (${offer.orderNumber})` : ''}`, { orderId: offer.orderId, offerAttemptId: offer.offerAttemptId, mover: a.id });
    }
    await deps.sleep(POLL_EVERY_MS);
  }
  return { ok: false, summary: `${a.id} saw no offer${cmd.order ? ` for ${cmd.order}` : ''} in ${cmd.waitSeconds} s (still online: run "${cmd.role} offline" to stop)`, details: { mover: a.id } };
}

async function goOfflineAs(a: Signed): Promise<HelperResult> {
  const r = await POST(`/${a.kind}/go-offline`, {}, a.session.token);
  return r.ok || codeOf(r) === 'ALREADY_OFFLINE' ? done(`${a.id} is offline`) : refused(`${a.id} go offline`, r);
}

/** The rider's leg for `orderId`, as the rider's own app sees it. */
async function riderLeg(a: Signed, orderId: string): Promise<any | null> {
  return activeLegsOf((await GET('/rider/orders/active-legs', a.session.token)).json).find((l) => (l.id ?? l.orderId) === orderId) ?? null;
}

const RUNGS: ReadonlyArray<readonly [status: string, slug: string]> = [
  ['RIDER_ASSIGNED', 'en-route-pickup'],
  ['RIDER_EN_ROUTE_PICKUP', 'arrived-pickup'],
  ['RIDER_ARRIVED_PICKUP', 'picked-up'],
  ['PICKED_UP', 'en-route-delivery'],
  ['EN_ROUTE_DELIVERY', 'arrived'],
];

/** Walk the leg from its current rung up to (and including) the PUT that reaches `until`. */
async function walk(a: Signed, orderId: string, from: string, until: 'RIDER_ARRIVED_PICKUP' | 'PICKED_UP' | 'ARRIVED'): Promise<Res | null> {
  const start = RUNGS.findIndex(([s]) => s === from);
  const stop = RUNGS.findIndex(([, slug]) => ({ RIDER_ARRIVED_PICKUP: 'arrived-pickup', PICKED_UP: 'picked-up', ARRIVED: 'arrived' })[until] === slug);
  if (start < 0 || start > stop) return null;
  let last: Res | null = null;
  for (const [, slug] of RUNGS.slice(start, stop + 1)) {
    last = await PUT(`/rider/orders/${orderId}/${slug}`, {}, a.session.token);
    if (!last.ok) return last;
  }
  return last;
}

async function riderPickup(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const leg = await riderLeg(a, cmd.order!);
  if (!leg) return { ok: false, summary: `${a.id} does not hold ${cmd.order}`, details: {} };
  const r = await walk(a, cmd.order!, leg.status, 'PICKED_UP');
  if (r && !r.ok) return refused(`${a.id} walk ${cmd.order} to pickup`, r);
  return done(`${a.id} picked up ${cmd.order}; it is on its way`, { from: leg.status });
}

async function riderDeliver(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const leg = await riderLeg(a, cmd.order!);
  if (!leg) return { ok: false, summary: `${a.id} does not hold ${cmd.order}`, details: {} };
  const r = await walk(a, cmd.order!, leg.status, 'ARRIVED');
  if (r && !r.ok) return refused(`${a.id} walk ${cmd.order} to the door`, r);
  const door = cmd.at ?? (typeof leg.deliveryLat === 'number' && typeof leg.deliveryLng === 'number' ? { lat: leg.deliveryLat, lng: leg.deliveryLng } : null);
  if (!door) return { ok: false, summary: `${cmd.order} carries no door position; pass --at <lat,lng> of the door`, details: {} };
  const h = await POST(`/rider/orders/${cmd.order}/handover`, { outcome: 'paid', gps: door, ridePin: cmd.pin }, a.session.token);
  return h.ok ? done(`${a.id} handed ${cmd.order} over at the door (cash paid, PIN accepted)`, { status: h.json?.data?.status }) : refused(`${a.id} door handover`, h);
}

// ── taxi driver ─────────────────────────────────────────────────────────────

async function driverRide(a: Signed, rideId: string): Promise<any | null> {
  return activeLegsOf((await GET('/driver/rides/active', a.session.token)).json).find((r) => r.id === rideId) ?? null;
}

async function driverArrive(a: Signed, cmd: HelperCommand, deps: HelperDeps): Promise<HelperResult> {
  const ride = await driverRide(a, cmd.order!);
  if (!ride) return { ok: false, summary: `${a.id} does not hold ride ${cmd.order}`, details: {} };
  const pickup = cmd.at ?? (typeof ride.pickupLat === 'number' ? { lat: ride.pickupLat, lng: ride.pickupLng } : null);
  if (!pickup) return { ok: false, summary: `ride ${cmd.order} carries no pickup position; pass --at <lat,lng>`, details: {} };
  if (ride.status === 'DRIVER_ASSIGNED') {
    const en = await PUT(`/driver/rides/${cmd.order}/en-route`, {}, a.session.token);
    if (!en.ok) return refused(`${a.id} en route`, en);
  }
  const fix = () => PUT('/driver/location', { latitude: pickup.lat, longitude: pickup.lng, accuracy: 5 }, a.session.token);
  await fix();
  let arrived = await PUT(`/driver/rides/${cmd.order}/arrived`, {}, a.session.token);
  if (arrived.status === 409 && codeOf(arrived) === 'ARRIVAL_NOT_VERIFIED') {
    // The location route keeps one fix per 10 s: report again past it, as a phone's next GPS tick would.
    await deps.sleep(LOCATION_DEBOUNCE_MS);
    await fix();
    arrived = await PUT(`/driver/rides/${cmd.order}/arrived`, {}, a.session.token);
  }
  return arrived.ok ? done(`${a.id} arrived at the pickup of ${cmd.order}`, { at: pickup }) : refused(`${a.id} arrived`, arrived);
}

async function driverStart(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const v = await PUT(`/driver/rides/${cmd.order}/verify-pin`, { pin: cmd.pin }, a.session.token);
  if (!v.ok) return refused(`${a.id} verify the passenger's PIN`, v);
  const s = await PUT(`/driver/rides/${cmd.order}/start`, {}, a.session.token);
  return s.ok ? done(`${a.id} verified the PIN and started ${cmd.order}`) : refused(`${a.id} start the trip`, s);
}

async function driverFinish(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const ride = await driverRide(a, cmd.order!);
  const drop = cmd.at ?? (ride && typeof ride.deliveryLat === 'number' ? { lat: ride.deliveryLat, lng: ride.deliveryLng } : null);
  if (!drop) return { ok: false, summary: `ride ${cmd.order} carries no drop-off position; pass --at <lat,lng>`, details: {} };
  const h = await POST(`/driver/rides/${cmd.order}/handover`, { outcome: cmd.outcome, gps: drop }, a.session.token);
  return h.ok ? done(`${a.id} ended ${cmd.order}: ${cmd.outcome === 'paid' ? 'cash paid' : 'no-show recorded'}`, { status: h.json?.data?.status }) : refused(`${a.id} end the trip (${cmd.outcome})`, h);
}

// ── courier ────────────────────────────────────────────────────────────────

async function courierCollect(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const leg = await riderLeg(a, cmd.order!);
  if (!leg) return { ok: false, summary: `${a.id} does not hold ${cmd.order}`, details: {} };
  const r = await walk(a, cmd.order!, leg.status, 'RIDER_ARRIVED_PICKUP');
  if (r && !r.ok) return refused(`${a.id} walk ${cmd.order} to the pickup`, r);
  const pick = cmd.at ?? (typeof leg.pickupLat === 'number' ? { lat: leg.pickupLat, lng: leg.pickupLng } : null);
  if (!pick) return { ok: false, summary: `${cmd.order} carries no pickup position; pass --at <lat,lng>`, details: {} };
  const paid = await POST(`/courier/order/${cmd.order}/collect`, { outcome: 'paid', gps: pick }, a.session.token);
  if (!paid.ok && codeOf(paid) !== 'ALREADY_COLLECTED') return refused(`${a.id} collect the sender's cash`, paid);
  const photo = await upload(`/courier/order/${cmd.order}/pickup-proof-photo`, a.session.token, { name: 'pickup.png', type: 'image/png', bytes: uniquePng(`helper-${cmd.order}-pickup`) });
  if (!photo.ok) return refused(`${a.id} upload the pickup photo`, photo);
  const proof = await POST(`/courier/order/${cmd.order}/pickup-proof`, { proofPhotoUrl: photo.json?.data?.url, gps: pick }, a.session.token);
  return proof.ok ? done(`${a.id} collected the cash and picked the parcel up with a photo`, { status: proof.json?.data?.status }) : refused(`${a.id} pickup proof`, proof);
}

async function courierDeliver(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const leg = await riderLeg(a, cmd.order!);
  if (!leg) return { ok: false, summary: `${a.id} does not hold ${cmd.order}`, details: {} };
  const r = await walk(a, cmd.order!, leg.status, 'ARRIVED');
  if (r && !r.ok) return refused(`${a.id} walk ${cmd.order} to the drop-off`, r);
  const photo = await upload(`/courier/order/${cmd.order}/proof-photo`, a.session.token, { name: 'proof.png', type: 'image/png', bytes: uniquePng(`helper-${cmd.order}-proof`) });
  if (!photo.ok) return refused(`${a.id} upload the drop-off photo`, photo);
  const proof = await POST(`/courier/order/${cmd.order}/proof`, { proofPhotoUrl: photo.json?.data?.url }, a.session.token);
  return proof.ok ? done(`${a.id} delivered ${cmd.order} with a drop-off photo`, { status: proof.json?.data?.status }) : refused(`${a.id} drop-off proof`, proof);
}

// ── store ──────────────────────────────────────────────────────────────────

/** The store this owner account runs, as its own profile reports it. */
async function ownStore(a: Signed): Promise<any | null> {
  const d = (await GET('/vendor/profile', a.session.token)).json?.data;
  const rows: any[] = Array.isArray(d?.vendors) ? d.vendors : d?.vendor ? [d.vendor] : d?.id ? [d] : [];
  return rows.find((v) => v?.id) ?? null;
}

/** The toggle routes flip a flag; ask twice at most to reach the wanted value. */
async function setFlag(token: string, path: string, field: 'isCurrentlyOpen' | 'acceptingOrders', want: boolean): Promise<boolean> {
  let r = await PUT(path, {}, token);
  if (r.json?.data?.[field] !== want) r = await PUT(path, {}, token);
  return r.json?.data?.[field] === want;
}

async function storeOpen(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const v = await ownStore(a);
  if (!v) return { ok: false, summary: `${a.id} runs no store (provision the journeys roster first)`, details: {} };
  if (cmd.at) {
    const moved = await PUT('/vendor/profile', { latitude: cmd.at.lat, longitude: cmd.at.lng }, a.session.token);
    if (!moved.ok) return refused(`${a.id} move the store pin`, moved);
  }
  const open = await setFlag(a.session.token, '/vendor/vendor/toggle-open', 'isCurrentlyOpen', true);
  const accepting = await setFlag(a.session.token, '/vendor/vendor/toggle-orders', 'acceptingOrders', true);
  const items = listOf((await GET('/vendor/items?limit=50', a.session.token)).json).filter((i) => i.isAvailable !== false);
  const ok = open && accepting && v.status === 'ACTIVE' && items.length > 0;
  const pin = cmd.at ?? { lat: v.latitude, lng: v.longitude };
  return {
    ok,
    summary: ok
      ? `${a.id} "${v.name}" is open and accepting at ${pin.lat},${pin.lng}; order e.g. "${items[0].name}" (${items[0].basePrice} GYD)`
      : `${a.id} "${v.name}" is not ready: status=${v.status} open=${open} accepting=${accepting} items=${items.length}`,
    details: { vendorId: v.id, name: v.name, pin, item: items[0] ? { id: items[0].id, name: items[0].name, price: items[0].basePrice } : null },
  };
}

const ACTIVE_ORDER = new Set(['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED']);

async function storeOrders(a: Signed): Promise<any[]> {
  return listOf((await GET('/vendor/orders?limit=50', a.session.token)).json).filter((o) => ACTIVE_ORDER.has(o.status));
}

async function storeAccept(a: Signed, cmd: HelperCommand, deps: HelperDeps): Promise<HelperResult> {
  let orderId = cmd.order;
  if (!orderId) {
    deps.log(`${a.id} is waiting up to ${cmd.waitSeconds} s for a new order to accept (after its 5-minute hold)…`);
    const deadline = deps.now() + cmd.waitSeconds * 1000;
    while (deps.now() < deadline && !orderId) {
      const pending = (await storeOrders(a)).filter((o) => o.status === 'PENDING').sort((x, y) => Date.parse(y.createdAt ?? 0) - Date.parse(x.createdAt ?? 0));
      orderId = pending[0]?.id;
      if (!orderId) await deps.sleep(POLL_EVERY_MS);
    }
    if (!orderId) return { ok: false, summary: `${a.id} received no order to accept in ${cmd.waitSeconds} s`, details: {} };
  }
  const r = await PUT(`/vendor/orders/${orderId}/accept`, {}, a.session.token);
  return r.ok ? done(`${a.id} accepted ${orderId}`, { orderId, status: r.json?.data?.status }) : refused(`${a.id} accept ${orderId}`, r, { orderId });
}

async function storeReady(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const p = await PUT(`/vendor/orders/${cmd.order}/preparing`, {}, a.session.token);
  if (!p.ok && codeOf(p) !== 'INVALID_STATUS') return refused(`${a.id} mark preparing`, p);
  const r = await PUT(`/vendor/orders/${cmd.order}/ready`, {}, a.session.token);
  return r.ok ? done(`${a.id} marked ${cmd.order} ready`, { status: r.json?.data?.status }) : refused(`${a.id} mark ready`, r);
}

async function storeHandover(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await PUT(`/vendor/orders/${cmd.order}/complete-pickup`, { code: cmd.code }, a.session.token);
  return r.ok ? done(`${a.id} handed ${cmd.order} over at the counter (code accepted)`, { status: r.json?.data?.status }) : refused(`${a.id} counter handover`, r);
}

/** Closed, not accepting, and back at its roster pin if a session moved it. */
async function storeClose(a: Signed): Promise<HelperResult> {
  const v = await ownStore(a);
  if (!v) return { ok: false, summary: `${a.id} runs no store`, details: {} };
  const closed = await setFlag(a.session.token, '/vendor/vendor/toggle-open', 'isCurrentlyOpen', false);
  const stopped = await setFlag(a.session.token, '/vendor/vendor/toggle-orders', 'acceptingOrders', false);
  let homed = true;
  if (Math.abs(Number(v.latitude) - a.lat) > 1e-6 || Math.abs(Number(v.longitude) - a.lng) > 1e-6) {
    homed = (await PUT('/vendor/profile', { latitude: a.lat, longitude: a.lng }, a.session.token)).ok;
  }
  const ok = closed && stopped && homed;
  return { ok, summary: ok ? `${a.id} "${v.name}" is closed, not accepting, at its roster pin` : `${a.id} closed=${closed} notAccepting=${stopped} pinHome=${homed}`, details: {} };
}

// ── customer ───────────────────────────────────────────────────────────────

/**
 * A saved address AT this point (within ~10 m), else a new one there. The
 * journeys' ensureAddress reuses the customer's default wherever it is; a
 * helper door must be where the owner-rider actually is.
 */
async function addressAt(c: Session, p: Point): Promise<string | null> {
  const list = listOf((await GET('/customer/addresses', c.token)).json);
  const near = list.find((a) => Math.abs(Number(a.latitude) - p.lat) < 1e-4 && Math.abs(Number(a.longitude) - p.lng) < 1e-4);
  if (near?.id) return near.id;
  const a = await POST('/customer/addresses', {
    label: 'Phone test door', addressLine1: 'Phone test door', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: p.lat, longitude: p.lng, isDefault: false,
  }, c.token);
  return a.json?.data?.id ?? a.json?.data?.address?.id ?? null;
}

async function customerOrderAt(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const store = (await GET(`/customer/vendors/${cmd.store}`, a.session.token)).json?.data;
  if (!store?.id) return { ok: false, summary: `store ${cmd.store} is not visible to ${a.id}`, details: {} };
  const items: any[] = (store.categories ?? []).flatMap((c: any) => c.items ?? []);
  const item = cmd.item ? items.find((i) => i.id === cmd.item) : items[0];
  if (!item) return { ok: false, summary: `store "${store.name}" shows no available item${cmd.item ? ` ${cmd.item}` : ''}`, details: {} };
  await clearCart(a.session);
  const add = await POST('/customer/cart/items', { vendorId: store.id, itemId: item.id, quantity: 1 }, a.session.token);
  if (!add.ok) return refused(`${a.id} add "${item.name}" to the cart`, add);
  const body: Record<string, unknown> = { paymentMethod: 'CASH' };
  if (cmd.pickup) {
    body['fulfillmentSelections'] = { [store.id]: 'PICKUP' };
  } else {
    // Delivery: the door is --at, else a few hundred metres from the store; express skips the 5-minute hold.
    const door = cmd.at ?? { lat: Number(store.latitude) + 0.002, lng: Number(store.longitude) + 0.002 };
    const addressId = await addressAt(a.session, door);
    if (!addressId) return { ok: false, summary: `${a.id} could not save a delivery address at ${door.lat},${door.lng}`, details: {} };
    const addr = await PUT('/customer/cart/address', { addressId }, a.session.token);
    if (!addr.ok) return refused(`${a.id} set the delivery address`, addr);
    body['express'] = true;
  }
  const res = await req('POST', '/customer/checkout', { token: a.session.token, body, headers: { 'Idempotency-Key': idemKey(`helper-${a.id}`, `${store.id}-${Date.now()}`) } });
  const orderId = orderIdsOf(res)[0];
  if (!res.ok || !orderId) return refused(`${a.id} checkout at "${store.name}"`, res);
  const o = (res.json?.data?.orders ?? [res.json?.data?.order])[0] ?? {};
  return done(`${a.id} placed ${orderId}${o.orderNumber ? ` (${o.orderNumber})` : ''} at "${store.name}": ${cmd.pickup ? 'counter pickup' : 'express delivery'}, cash${o.holdExpiresAt ? `; the store sees it after ${o.holdExpiresAt}` : ''}`, { orderId, orderNumber: o.orderNumber, holdExpiresAt: o.holdExpiresAt ?? null });
}

async function customerCodes(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await GET(`/customer/orders/${cmd.order}`, a.session.token);
  if (!r.ok) return refused(`${a.id} read ${cmd.order}`, r);
  const o = r.json?.data ?? {};
  const parts = [`status ${o.status}`, o.pickupCode ? `pickup code ${o.pickupCode}` : '', o.ridePin ? `door PIN ${o.ridePin}` : ''].filter(Boolean);
  return done(`${cmd.order}: ${parts.join(' · ')}`, { status: o.status, pickupCode: o.pickupCode ?? null, doorPin: o.ridePin ?? null });
}

async function customerCancel(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await POST(`/customer/orders/${cmd.order}/cancel`, { reason: 'phone test helper: the check is over' }, a.session.token);
  return r.ok ? done(`${a.id} cancelled ${cmd.order}`) : refused(`${a.id} cancel ${cmd.order}`, r);
}

async function customerRide(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await POST('/rides/request', {
    pickup: cmd.at, dropoff: cmd.to, pickupAddress: 'Phone test pickup', dropoffAddress: 'Phone test drop-off', passengerCount: 1, rideClass: 'ECONOMY',
  }, a.session.token);
  const ride = r.json?.data?.ride;
  return r.ok && ride?.id ? done(`${a.id} requested ride ${ride.id} (status ${ride.status}); the passenger PIN is ${ride.ridePin}`, { rideId: ride.id, status: ride.status, pin: ride.ridePin ?? null }) : refused(`${a.id} request a ride`, r);
}

async function customerRidePin(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await GET(`/rides/${cmd.order}`, a.session.token);
  if (!r.ok) return refused(`${a.id} read ride ${cmd.order}`, r);
  return done(`ride ${cmd.order}: status ${r.json?.data?.status} · passenger PIN ${r.json?.data?.ridePin ?? '—'}`, { status: r.json?.data?.status, pin: r.json?.data?.ridePin ?? null });
}

async function customerCancelRide(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await POST(`/rides/${cmd.order}/cancel`, { reason: 'phone test helper: the check is over' }, a.session.token);
  return r.ok ? done(`${a.id} cancelled ride ${cmd.order}`) : refused(`${a.id} cancel ride ${cmd.order}`, r);
}

async function customerSend(a: Signed, cmd: HelperCommand): Promise<HelperResult> {
  const r = await POST('/courier/order', {
    pickup: cmd.at, dropoff: cmd.to, pickupAddress: 'Phone test parcel pickup', dropoffAddress: 'Phone test parcel drop-off',
    packageSize: 'SMALL', packageDescription: 'Phone test parcel (synthetic)', speed: 'STANDARD',
    recipientName: 'Test Recipient', recipientPhone: RECIPIENT_PHONE, payer: 'SENDER',
  }, a.session.token);
  const id = r.json?.data?.orderId ?? r.json?.data?.id ?? r.json?.data?.order?.id;
  return r.ok && id ? done(`${a.id} sent parcel ${id} (fee ${r.json?.data?.fee ?? '?'} GYD, cash by the sender)`, { orderId: id, fee: r.json?.data?.fee ?? null }) : refused(`${a.id} send a parcel`, r);
}

// ── provider ───────────────────────────────────────────────────────────────

async function providerJobs(a: Signed): Promise<HelperResult> {
  const jobs = listOf((await GET('/services/jobs', a.session.token)).json).filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status));
  return done(jobs.length ? `${a.id} has ${jobs.length} open job(s): ${jobs.map((j) => `${j.id} ${j.status}`).join('; ')}` : `${a.id} has no open job`, { jobs: jobs.map((j) => ({ id: j.id, status: j.status })) });
}

async function providerStep(a: Signed, cmd: HelperCommand, step: 'quote' | 'confirm' | 'complete'): Promise<HelperResult> {
  const r = await POST(`/services/jobs/${cmd.job}/${step}`, step === 'quote' ? { amount: cmd.amount } : {}, a.session.token);
  const said = { quote: `quoted ${cmd.amount} GYD for`, confirm: 'confirmed the booked time of', complete: 'completed' }[step];
  return r.ok ? done(`${a.id} ${said} job ${cmd.job}`, { status: r.json?.data?.status }) : refused(`${a.id} ${step} job ${cmd.job}`, r);
}

// ── everyone ───────────────────────────────────────────────────────────────

async function everyone(action: 'status' | 'cleanup', deps: HelperDeps): Promise<HelperResult> {
  const lines: string[] = [];
  let ok = true;
  for (const id of Object.keys(ACTORS)) {
    const a = await signIn(id);
    if (a.kind) {
      const path = a.kind === 'rider' ? '/rider/orders/active-legs' : '/driver/rides/active';
      const held = activeLegsOf((await GET(path, a.session.token)).json).map((l) => `${l.id ?? l.orderId} ${l.status}`);
      if (action === 'cleanup') {
        const off = await goOfflineAs(a);
        ok &&= off.ok;
        lines.push(`${id}: ${off.summary}${held.length ? ` — still holds ${held.join(', ')} (finish or hand it back first)` : ''}`);
      } else {
        lines.push(`${id}: ${held.length ? `holds ${held.join(', ')}` : 'holds nothing'}`);
      }
    } else if (a.roles.includes('store')) {
      if (action === 'cleanup') {
        const c = await storeClose(a);
        ok &&= c.ok;
        lines.push(`${id}: ${c.summary}`);
      } else {
        const v = await ownStore(a);
        lines.push(`${id}: "${v?.name}" open=${v?.isCurrentlyOpen} accepting=${v?.acceptingOrders} active orders=${(await storeOrders(a)).length}`);
      }
    }
  }
  for (const l of lines) deps.log(`  ${l}`);
  return { ok, summary: action === 'cleanup' ? (ok ? 'every helper mover is offline and every helper store closed and back home' : 'cleanup incomplete — see the lines above') : 'status of every helper account', details: { lines } };
}

/** Run one parsed command as its actor. */
export async function runHelperCommand(cmd: HelperCommand, deps: HelperDeps): Promise<HelperResult> {
  if (cmd.role === 'all') return everyone(cmd.action as 'status' | 'cleanup', deps);
  const a = await signIn(cmd.as);
  switch (`${cmd.role} ${cmd.action}`) {
    case 'customer order': return customerOrderAt(a, cmd);
    case 'customer codes': return customerCodes(a, cmd);
    case 'customer cancel': return customerCancel(a, cmd);
    case 'customer ride': return customerRide(a, cmd);
    case 'customer ride-pin': return customerRidePin(a, cmd);
    case 'customer cancel-ride': return customerCancelRide(a, cmd);
    case 'customer send': return customerSend(a, cmd);
    case 'store open': return storeOpen(a, cmd);
    case 'store orders': {
      const rows = await storeOrders(a);
      return done(rows.length ? `${a.id} active orders: ${rows.map((o) => `${o.id} ${o.orderNumber ?? ''} ${o.status}`).join('; ')}` : `${a.id} has no active order`, { orders: rows.map((o) => ({ id: o.id, status: o.status })) });
    }
    case 'store accept': return storeAccept(a, cmd, deps);
    case 'store ready': return storeReady(a, cmd);
    case 'store handover': return storeHandover(a, cmd);
    case 'store close': return storeClose(a);
    case 'rider accept':
    case 'courier accept':
    case 'driver accept': return acceptOffer(a, cmd, deps);
    case 'rider pickup': return riderPickup(a, cmd);
    case 'rider deliver': return riderDeliver(a, cmd);
    case 'courier collect': return courierCollect(a, cmd);
    case 'courier deliver': return courierDeliver(a, cmd);
    case 'rider offline':
    case 'courier offline':
    case 'driver offline': return goOfflineAs(a);
    case 'driver arrive': return driverArrive(a, cmd, deps);
    case 'driver start': return driverStart(a, cmd);
    case 'driver finish': return driverFinish(a, cmd);
    case 'provider jobs': return providerJobs(a);
    case 'provider quote': return providerStep(a, cmd, 'quote');
    case 'provider confirm': return providerStep(a, cmd, 'confirm');
    case 'provider complete': return providerStep(a, cmd, 'complete');
    default: throw new HelperUsage(`${cmd.role} ${cmd.action} is not an action`);
  }
}

export const HELPER_EXIT = { OK: 0, FAILED: 1, USAGE: 2, REFUSED: 3 } as const;

/** The whole run: parse, the target guard, then the one action. Returns the exit code. */
export async function phoneHelper(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  deps: HelperDeps = { log: (l) => { process.stdout.write(`${l}\n`); }, sleep: async (ms) => { await realSleep(ms); }, now: () => Date.now() },
): Promise<number> {
  let cmd: HelperCommand;
  try {
    cmd = parseHelperArgs(argv);
  } catch (e) {
    deps.log(`usage: ${e instanceof Error ? e.message : String(e)}`);
    return HELPER_EXIT.USAGE;
  }
  try {
    const adminPhone = requireAdminPhone(env['LIVETEST_ADMIN_PHONE']);
    refuseLivePhones([...helperPhones(), adminPhone]);
    await refusePublicTarget(ORIGIN, env);
    const identity = await refuseUnsafeIdentity(
      { get: async (p, token) => { const r = await GET(p, token); return { status: r.status, json: r.json }; } },
      async () => (await login(adminPhone)).token,
      env,
    );
    deps.log(`phone helper → ${ORIGIN} · deployment ${identity.deploymentId} (${identity.environment}) · ${cmd.role} ${cmd.action}${cmd.role === 'all' ? '' : ` as ${cmd.as}`}`);
  } catch (e) {
    if (e instanceof TargetRefused) {
      deps.log(`REFUSED: ${e.message}`);
      return HELPER_EXIT.REFUSED;
    }
    throw e;
  }
  const result = await runHelperCommand(cmd, deps);
  deps.log(`${result.ok ? 'OK' : 'FAILED'}: ${result.summary}`);
  deps.log(JSON.stringify({ ok: result.ok, role: cmd.role, action: cmd.action, as: cmd.role === 'all' ? null : cmd.as, at: new Date(deps.now()).toISOString(), ...result.details }));
  return result.ok ? HELPER_EXIT.OK : HELPER_EXIT.FAILED;
}
