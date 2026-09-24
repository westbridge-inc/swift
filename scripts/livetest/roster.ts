// The sanctioned 24-account roster [SWIFT-081], seeded through the REAL signup
// path so the harness exercises onboarding, not a DB shortcut. Idempotent:
// re-running logs existing accounts in.
//
// [TASK-057] Every phone here is in +5920…, a range no Guyana subscriber can
// hold (a 0 after +592 is never a subscriber number), inside the +59204 block.
// The former +592600 numbers were a LIVE Digicel range: with real SMS on
// (Phase B), the shared worker would have texted real people. guard.ts refuses
// to run if any fixture phone leaves +5920 (the Ofcom drama range used only for
// the non-Guyana refusal is the one listed exception).
//
// [TASK-057] The journey suite reuses these accounts and adds a few more (a
// taxi passenger, a bicycle rider, a service provider); seedJourneyRoster()
// signs them all in. Documents, approvals and going online happen in
// provision.ts.

import { randomBytes } from 'node:crypto';
import { signupOrLogin, login, FIXTURE_PNG, upload, POST, type Session } from './client.js';

export interface Handle { id: string; phone: string; session: Session; lat: number; lng: number }
export interface Roster {
  customers: Record<string, Handle>;
  vendors: Record<string, Handle & { vendorType: string; vendorId?: string }>;
  movers: Record<string, Handle & { kind: 'rider' | 'driver'; vehicleType?: string; plate?: string; profileId?: string }>;
  /** [TASK-057] Service providers (customer accounts with a provider profile). */
  providers?: Record<string, Handle & { trade: string }>;
  /** [TASK-057] A second admin, when the operator provisioned one (LIVETEST_ADMIN2_PHONE). */
  admin2?: Session | null;
}

const CUSTOMERS = [
  { id: 'C1', phone: '+5920401001', first: 'Aria', lat: 6.8125, lng: -58.1500 },
  { id: 'C2', phone: '+5920401002', first: 'Ben', lat: 6.8060, lng: -58.1585 },
  { id: 'C3', phone: '+5920401003', first: 'Cleo', lat: 6.8230, lng: -58.1420 }, // L1 tier-gate testbed
  { id: 'C4', phone: '+5920401004', first: 'Dev', lat: 6.8045, lng: -58.1633 },
  { id: 'C5', phone: '+5920401005', first: 'Esi', lat: 6.7980, lng: -58.1570 },
  { id: 'C6', phone: '+5920401006', first: 'Femi', lat: 6.8150, lng: -58.1445 },
];

const VENDORS = [
  { id: 'R1', phone: '+5920402011', name: 'TEST-Kitchen-One', type: 'RESTAURANT', lat: 6.8090, lng: -58.1520 },
  { id: 'R2', phone: '+5920402012', name: 'TEST-Kitchen-Two', type: 'RESTAURANT', lat: 6.8210, lng: -58.1440 }, // pickup
  { id: 'R3', phone: '+5920402013', name: 'TEST-Kitchen-Three', type: 'RESTAURANT', lat: 6.7920, lng: -58.1560 }, // suspend
  { id: 'ST1', phone: '+5920402021', name: 'TEST-Grocery-One', type: 'SUPERMARKET', lat: 6.8140, lng: -58.1480 }, // stock=1
  { id: 'OV1', phone: '+5920402031', name: 'TEST-Pharma-One', type: 'STORE', lat: 6.8060, lng: -58.1500 },
  { id: 'SV1', phone: '+5920402041', name: 'TEST-Sparks', type: 'SERVICE', lat: 6.8100, lng: -58.1500 },
];

const MOVERS: { id: string; phone: string; first: string; lat: number; lng: number; kind: 'rider' | 'driver' }[] = [
  { id: 'DR1', phone: '+5920403051', first: 'Uno', lat: 6.8100, lng: -58.1515, kind: 'rider' },
  { id: 'DR2', phone: '+5920403052', first: 'Dos', lat: 6.8175, lng: -58.1470, kind: 'rider' },
  { id: 'DR3', phone: '+5920403053', first: 'Tres', lat: 6.7960, lng: -58.1630, kind: 'rider' },
  { id: 'T1', phone: '+5920403061', first: 'Alpha', lat: 6.8050, lng: -58.1640, kind: 'driver' },
  { id: 'T2', phone: '+5920403062', first: 'Bravo', lat: 6.8120, lng: -58.1560, kind: 'driver' },
  { id: 'T3', phone: '+5920403063', first: 'Charlie', lat: 6.8300, lng: -58.1380, kind: 'driver' },
];

/** Numbers the journeys send to or file that are not accounts (never a subscriber: +5920…). */
export const CONTACT_PHONE = '+5920405098'; // SOS emergency contact
export const BUSINESS_PHONE = '+5920405090'; // a fresh store's business line
export const RECIPIENT_PHONE = '+5920405091'; // courier recipient

/** Every fixed phone the runner uses, for the guard (guard.ts refuseLivePhones). */
export function fixturePhones(): string[] {
  return [
    ...CUSTOMERS.map((c) => c.phone), ...VENDORS.map((v) => v.phone), ...MOVERS.map((m) => m.phone),
    ...JOURNEY_CUSTOMERS.map((c) => c.phone), ...JOURNEY_MOVERS.map((m) => m.phone), ...PROVIDERS.map((p) => p.phone),
    CONTACT_PHONE, BUSINESS_PHONE, RECIPIENT_PHONE,
  ];
}

/** Selfie bytes unique per account: a valid PNG header, then an ignored trailer. */
export function uniquePng(label: string): Buffer {
  return Buffer.concat([FIXTURE_PNG, Buffer.from(`\n${label}:${randomBytes(8).toString('hex')}`)]);
}

async function selfie(session: Session, label: string): Promise<boolean> {
  const r = await upload('/auth/selfie', session.token, { name: 'selfie.png', type: 'image/png', bytes: uniquePng(label) });
  return r.ok;
}

export async function seedRoster(log: (s: string) => void): Promise<Roster> {
  const roster: Roster = { customers: {}, vendors: {}, movers: {} };

  for (const c of CUSTOMERS) {
    const session = await signupOrLogin(c.phone, { firstName: `TEST-${c.first}`, lastName: 'Customer', role: 'CUSTOMER' });
    // Mandatory signup selfie — without it every order 403s SELFIE_REQUIRED.
    await selfie(session, c.id);
    roster.customers[c.id] = { id: c.id, phone: c.phone, session, lat: c.lat, lng: c.lng };
  }
  log(`  customers: ${Object.keys(roster.customers).length}`);

  for (const v of VENDORS) {
    const session = await signupOrLogin(v.phone, { firstName: v.name, lastName: 'Owner', role: 'VENDOR' });
    // become is idempotent: an already-provisioned owner returns their vendor.
    // The vendor agreement must be accepted explicitly (partner.routes.ts).
    const b = await POST('/partner/become', {
      role: 'VENDOR',
      acceptAgreement: true,
      business: {
        name: v.name, vendorType: v.type, phone: v.phone,
        addressLine1: `1 ${v.id} St`, city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: v.lat, longitude: v.lng,
      },
    }, session.token);
    const vendorId = b.json?.data?.vendor?.id ?? b.json?.data?.id ?? b.json?.data?.vendorId;
    roster.vendors[v.id] = { id: v.id, phone: v.phone, session, lat: v.lat, lng: v.lng, vendorType: v.type, vendorId };
  }
  log(`  vendors: ${Object.keys(roster.vendors).length}`);

  for (const m of MOVERS) {
    const session = await signupOrLogin(m.phone, { firstName: `TEST-${m.first}`, lastName: m.kind === 'driver' ? 'Taxi' : 'Rider', role: 'MOVER' });
    // Movers also need the selfie before they can go online (rider/driver gate).
    await selfie(session, m.id);
    await POST('/partner/become', {
      role: 'MOVER',
      acceptAgreement: true,
      vehicleType: m.kind === 'driver' ? 'CAR' : 'MOTORCYCLE',
      vehicle: { make: 'Toyota', model: m.kind === 'driver' ? 'Allion' : 'CT100', year: 2020, color: 'Silver', licensePlate: m.kind === 'driver' ? `HC ${m.phone.slice(-4)}` : `${m.id}-1` },
    }, session.token);
    roster.movers[m.id] = { id: m.id, phone: m.phone, session, lat: m.lat, lng: m.lng, kind: m.kind };
  }
  log(`  movers: ${Object.keys(roster.movers).length}`);

  return roster;
}

// ── [TASK-057] the journey roster ────────────────────────────────────────────

const JOURNEY_CUSTOMERS = [
  ...CUSTOMERS,
  { id: 'C7', phone: '+5920401007', first: 'Gia', lat: 6.8110, lng: -58.1530 }, // taxi passenger (L2 via identity review)
  { id: 'C8', phone: '+5920401008', first: 'Hal', lat: 6.8140, lng: -58.1540 }, // courier sender
];
const JOURNEY_VENDORS = VENDORS.filter((v) => v.id !== 'SV1'); // services run through /services, not a SERVICE store
const JOURNEY_MOVERS: Array<{ id: string; phone: string; first: string; lat: number; lng: number; kind: 'rider' | 'driver'; vehicleType: string }> = [
  ...MOVERS.map((m) => ({ ...m, vehicleType: m.kind === 'driver' ? 'CAR' : 'MOTORCYCLE' })),
  { id: 'DR4', phone: '+5920403054', first: 'Cuatro', lat: 6.8095, lng: -58.1525, kind: 'rider', vehicleType: 'BICYCLE' },
];
const PROVIDERS = [
  { id: 'SP1', phone: '+5920404071', first: 'Joiner', trade: 'carpenter', lat: 6.8105, lng: -58.1505 },
];

/** Every journey account signed in (created on the first run). Movers and vendors hold their partner profile. */
export async function seedJourneyRoster(log: (s: string) => void): Promise<Roster> {
  const roster: Roster = { customers: {}, vendors: {}, movers: {}, providers: {}, admin2: null };

  for (const c of JOURNEY_CUSTOMERS) {
    const session = await signupOrLogin(c.phone, { firstName: `TEST-${c.first}`, lastName: 'Customer', role: 'CUSTOMER' });
    roster.customers[c.id] = { id: c.id, phone: c.phone, session, lat: c.lat, lng: c.lng };
  }
  log(`  customers: ${Object.keys(roster.customers).join(' ')}`);

  for (const v of JOURNEY_VENDORS) {
    const session = await signupOrLogin(v.phone, { firstName: v.name, lastName: 'Owner', role: 'VENDOR' });
    const b = await POST('/partner/become', {
      role: 'VENDOR',
      acceptAgreement: true,
      business: {
        name: v.name, vendorType: v.type, phone: v.phone,
        addressLine1: `1 ${v.id} St`, city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: v.lat, longitude: v.lng,
      },
    }, session.token);
    const vendorId = b.json?.data?.id ?? b.json?.data?.vendor?.id ?? b.json?.data?.vendorId;
    if (!vendorId) log(`  ${v.id}: become → ${b.status} ${b.text.slice(0, 160)}`);
    roster.vendors[v.id] = { id: v.id, phone: v.phone, session, lat: v.lat, lng: v.lng, vendorType: v.type, vendorId };
  }
  log(`  vendors: ${Object.keys(roster.vendors).join(' ')}`);

  for (const m of JOURNEY_MOVERS) {
    const session = await signupOrLogin(m.phone, { firstName: `TEST-${m.first}`, lastName: m.kind === 'driver' ? 'Taxi' : 'Rider', role: 'MOVER' });
    const plate = m.kind === 'driver' ? `HC ${m.phone.slice(-4)}` : `${m.id}-1`;
    const b = await POST('/partner/become', {
      role: 'MOVER',
      acceptAgreement: true,
      vehicleType: m.vehicleType,
      vehicle: { make: 'Toyota', model: m.kind === 'driver' ? 'Allion' : 'CT100', year: 2020, color: 'Silver', licensePlate: plate },
    }, session.token);
    if (!b.ok) log(`  ${m.id}: become → ${b.status} ${b.text.slice(0, 160)}`);
    roster.movers[m.id] = { id: m.id, phone: m.phone, session, lat: m.lat, lng: m.lng, kind: m.kind, vehicleType: m.vehicleType, plate, profileId: b.json?.data?.id };
  }
  log(`  movers: ${Object.keys(roster.movers).join(' ')}`);

  for (const p of PROVIDERS) {
    const session = await signupOrLogin(p.phone, { firstName: `TEST-${p.first}`, lastName: 'Provider', role: 'CUSTOMER' });
    roster.providers![p.id] = { id: p.id, phone: p.phone, session, lat: p.lat, lng: p.lng, trade: p.trade };
  }
  log(`  providers: ${Object.keys(roster.providers!).join(' ')}`);

  const admin2Phone = (process.env.LIVETEST_ADMIN2_PHONE ?? '').trim();
  if (admin2Phone) {
    try {
      roster.admin2 = await login(admin2Phone);
      log('  second admin: signed in (two-person cases will run)');
    } catch (e: any) {
      log(`  second admin: sign-in failed (${e?.message ?? e}); two-person cases will SKIP`);
    }
  } else {
    log('  second admin: none (LIVETEST_ADMIN2_PHONE unset); two-person cases will SKIP');
  }
  return roster;
}

/** A selfie for every account that lacks one (unique bytes per account). */
export async function ensureSelfies(roster: Roster, log: (s: string) => void): Promise<void> {
  const all = [
    ...Object.values(roster.customers), ...Object.values(roster.movers), ...Object.values(roster.providers ?? {}),
  ];
  let taken = 0;
  for (const h of all) {
    const prof = await (await import('./client.js')).GET('/customer/profile', h.session.token);
    if (prof.json?.data?.selfieCapturedAt) continue;
    if (await selfie(h.session, h.id)) taken += 1;
  }
  log(`  selfies captured this run: ${taken}`);
}
