// The sanctioned 24-account roster [SWIFT-081], seeded through the REAL signup
// path so the harness exercises onboarding, not a DB shortcut. Idempotent:
// re-running logs existing accounts in. Mirrors reports/TEST_ACCOUNTS.md.

import { signupOrLogin, captureSelfie, POST, type Session } from './client.js';

export interface Handle { id: string; phone: string; session: Session; lat: number; lng: number }
export interface Roster {
  customers: Record<string, Handle>;
  vendors: Record<string, Handle & { vendorType: string; vendorId?: string }>;
  movers: Record<string, Handle & { kind: 'rider' | 'driver' }>;
}

const CUSTOMERS = [
  { id: 'C1', phone: '+5926000001', first: 'Aria', lat: 6.8125, lng: -58.1500 },
  { id: 'C2', phone: '+5926000002', first: 'Ben', lat: 6.8060, lng: -58.1585 },
  { id: 'C3', phone: '+5926000003', first: 'Cleo', lat: 6.8230, lng: -58.1420 }, // L1 tier-gate testbed
  { id: 'C4', phone: '+5926000004', first: 'Dev', lat: 6.8045, lng: -58.1633 },
  { id: 'C5', phone: '+5926000005', first: 'Esi', lat: 6.7980, lng: -58.1570 },
  { id: 'C6', phone: '+5926000006', first: 'Femi', lat: 6.8150, lng: -58.1445 },
];

const VENDORS = [
  { id: 'R1', phone: '+5926000011', name: 'TEST-Kitchen-One', type: 'RESTAURANT', lat: 6.8090, lng: -58.1520 },
  { id: 'R2', phone: '+5926000012', name: 'TEST-Kitchen-Two', type: 'RESTAURANT', lat: 6.8210, lng: -58.1440 }, // pickup
  { id: 'R3', phone: '+5926000013', name: 'TEST-Kitchen-Three', type: 'RESTAURANT', lat: 6.7920, lng: -58.1560 }, // suspend
  { id: 'ST1', phone: '+5926000021', name: 'TEST-Grocery-One', type: 'SUPERMARKET', lat: 6.8140, lng: -58.1480 }, // stock=1
  { id: 'OV1', phone: '+5926000031', name: 'TEST-Pharma-One', type: 'STORE', lat: 6.8060, lng: -58.1500 },
  { id: 'SV1', phone: '+5926000041', name: 'TEST-Sparks', type: 'SERVICE', lat: 6.8100, lng: -58.1500 },
];

const MOVERS: { id: string; phone: string; first: string; lat: number; lng: number; kind: 'rider' | 'driver' }[] = [
  { id: 'DR1', phone: '+5926000051', first: 'Uno', lat: 6.8100, lng: -58.1515, kind: 'rider' },
  { id: 'DR2', phone: '+5926000052', first: 'Dos', lat: 6.8175, lng: -58.1470, kind: 'rider' },
  { id: 'DR3', phone: '+5926000053', first: 'Tres', lat: 6.7960, lng: -58.1630, kind: 'rider' },
  { id: 'T1', phone: '+5926000061', first: 'Alpha', lat: 6.8050, lng: -58.1640, kind: 'driver' },
  { id: 'T2', phone: '+5926000062', first: 'Bravo', lat: 6.8120, lng: -58.1560, kind: 'driver' },
  { id: 'T3', phone: '+5926000063', first: 'Charlie', lat: 6.8300, lng: -58.1380, kind: 'driver' },
];

export async function seedRoster(log: (s: string) => void): Promise<Roster> {
  const roster: Roster = { customers: {}, vendors: {}, movers: {} };

  for (const c of CUSTOMERS) {
    const session = await signupOrLogin(c.phone, { firstName: `TEST-${c.first}`, lastName: 'Customer', role: 'CUSTOMER' });
    // Mandatory signup selfie — without it every order 403s SELFIE_REQUIRED.
    await captureSelfie(session);
    roster.customers[c.id] = { id: c.id, phone: c.phone, session, lat: c.lat, lng: c.lng };
  }
  log(`  customers: ${Object.keys(roster.customers).length}`);

  for (const v of VENDORS) {
    const session = await signupOrLogin(v.phone, { firstName: v.name, lastName: 'Owner', role: 'VENDOR' });
    // become is idempotent-ish: an already-provisioned owner returns their vendor.
    const b = await POST('/partner/become', {
      role: 'VENDOR',
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
    await captureSelfie(session);
    await POST('/partner/become', {
      role: 'MOVER',
      vehicleType: m.kind === 'driver' ? 'CAR' : 'MOTORCYCLE',
      vehicle: { make: 'Toyota', model: m.kind === 'driver' ? 'Allion' : 'CT100', year: 2020, color: 'Silver', licensePlate: `${m.id}-1` },
    }, session.token);
    roster.movers[m.id] = { id: m.id, phone: m.phone, session, lat: m.lat, lng: m.lng, kind: m.kind };
  }
  log(`  movers: ${Object.keys(roster.movers).length}`);

  return roster;
}
