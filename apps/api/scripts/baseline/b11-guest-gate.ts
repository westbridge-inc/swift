/**
 * ELV-2 A12 — Scenario B11: GUEST BROWSE → ORDER GATE (INV-6 / INV-16).
 *
 * Proves: (1) full catalog browsing with ZERO account — public storefronts,
 * storefront detail, discovery categories, search — all 200 tokenless;
 * (2) the wall sits EXACTLY at ordering: cart/checkout mutations demand auth
 * (401), never a browse endpoint; (3) the tier gate is server-side at order
 * creation (an authenticated but tierless probe hits the SERVER check, not a
 * client hint).
 *
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b11-guest-gate.ts
 */
import { PrismaClient } from '@prisma/client';

const API = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

async function main() {
  // ── 1. guest browse: every discovery surface answers tokenless ────────────
  const browse: [string, string][] = [
    ['public storefront list', '/public/storefronts?limit=5'],
    ['discovery categories', '/discovery/categories'],
  ];
  const storefronts = await http('GET', '/public/storefronts?limit=5');
  if (storefronts.status !== 200) throw new Error(`FAIL guest storefronts: ${storefronts.status}`);
  const first = storefronts.json?.data?.storefronts?.[0] ?? storefronts.json?.data?.[0];
  for (const [name, path] of browse) {
    const r = await http('GET', path);
    if (r.status !== 200) throw new Error(`FAIL guest browse ${name}: ${r.status}`);
    log(`EVIDENCE guest ${name}`, { status: r.status });
  }
  // [F-024-02] Detail is MANDATORY: an empty/malformed storefront list used to
  // silently skip this leg and still print COMPLETE.
  if (!first?.slug) throw new Error('FAIL: storefront list returned no slugged storefront — the detail leg cannot be skipped');
  const detail = await http('GET', `/public/storefronts/${first.slug}`);
  if (detail.status !== 200) throw new Error(`FAIL guest storefront detail: ${detail.status}`);
  log('EVIDENCE guest storefront detail', { slug: first.slug, status: detail.status });

  // [F-024-02] The claimed SEARCH leg, actually exercised. The B11 law says
  // tokenless search browses open; the register tracks reality if it 401s.
  const failures: string[] = [];
  const search = await http('GET', '/search?q=pepperpot');
  if (search.status === 200) {
    log('EVIDENCE guest search open', { status: search.status });
  } else {
    failures.push(`guest search: expected 200 tokenless, got ${search.status} (F-225 — search sits behind auth; the browse wall is too early for search)`);
    log('LEG FAILED — guest search walled', { status: search.status });
  }

  // ── 2. the wall sits at ORDERING: mutations 401 tokenless ────────────────
  const gated: [string, string, string, unknown][] = [
    ['cart add', 'POST', '/customer/cart/items', { vendorId: 'x', itemId: 'x', quantity: 1 }],
    ['checkout', 'POST', '/customer/checkout', { paymentMethod: 'CASH' }],
    ['address create', 'POST', '/customer/addresses', { label: 'x', addressLine1: 'x', city: 'x', latitude: 1, longitude: 1 }],
  ];
  for (const [name, method, path, body] of gated) {
    const r = await http(method, path, body);
    if (r.status !== 401) throw new Error(`FAIL gate ${name}: expected 401 got ${r.status}`);
    log(`EVIDENCE order-gate ${name}`, { status: r.status });
  }

  // ── 3. no permission wall on browse: the SAME endpoints with a garbage
  //      token still refuse auth-required paths but browse stays open ───────
  const garbage = await http('GET', '/public/storefronts?limit=1', undefined, 'not-a-real-token');
  if (garbage.status !== 200) throw new Error(`FAIL: browse rejected a bad token (${garbage.status}) — a wall where none belongs`);
  log('EVIDENCE browse ignores junk tokens (no wall)', { status: garbage.status });

  // ── 4. [F-024-02] the tier gate is SERVER-side at order creation ─────────
  // An authenticated-but-tierless probe account (synthetic, L1, no ride
  // trust) requests a taxi: the SERVER must refuse with a machine code —
  // proof the gate is not a client hint.
  const PROBE_PHONE = '+5925566009';
  // Register through the REAL signup flow (idempotent: an existing account
  // just fails registration and logs in), then OTP login.
  await http('POST', '/auth/register', {
    phone: PROBE_PHONE, firstName: 'ELV1', lastName: 'TierProbe', role: 'CUSTOMER', countryCode: 'GY', acceptTerms: true,
  });
  let probeToken: string | undefined;
  for (let attempt = 1; attempt <= 6 && !probeToken; attempt++) {
    await http('POST', '/auth/send-otp', { phone: PROBE_PHONE });
    const v = await http('POST', '/auth/verify-otp', { phone: PROBE_PHONE, code: '000000' });
    probeToken = v.json?.data?.tokens?.accessToken ?? v.json?.data?.token;
    if (!probeToken && attempt < 6) await new Promise((r) => setTimeout(r, 8000));
  }
  if (!probeToken) throw new Error('FAIL: could not authenticate the tierless probe account');

  // [F-026-20] The probe must actually REACH the tier gate. Ride creation
  // checks the universal signup-selfie prerequisite FIRST — a fresh account
  // with no selfie is refused SELFIE_REQUIRED and never touches assertL2, so
  // accepting either code proved only "no photo is blocked", not the L2 gate.
  // Stamp the selfie (legit rig prep — other baseline fixtures do the same)
  // and pin the probe to L1, so the request clears the prerequisite and the
  // ONLY thing left to refuse it is the tier gate. Then require its EXACT code.
  const probeUser = await prisma.user.findFirst({ where: { phone: PROBE_PHONE }, select: { id: true, trustLevel: true } });
  if (!probeUser) throw new Error('FAIL: tier probe account not found after signup');
  await prisma.user.update({
    where: { id: probeUser.id },
    data: { selfieCapturedAt: new Date(), trustLevel: 'L1' as never },
  });

  const tierProbe = await http('POST', '/rides/request', {
    pickup: { lat: 6.8, lng: -58.15 }, dropoff: { lat: 6.82, lng: -58.17 },
    pickupAddress: 'ELV1 tier probe pickup', dropoffAddress: 'ELV1 tier probe dropoff',
    passengerCount: 1, rideClass: 'ECONOMY',
  }, probeToken);
  const tierCode = tierProbe.json?.error?.code ?? tierProbe.json?.code;
  if (tierProbe.status !== 403 || tierCode !== 'ID_VERIFICATION_REQUIRED') {
    throw new Error(`FAIL tier gate: a selfie-complete L1 account must be refused by the L2 tier gate — expected 403 ID_VERIFICATION_REQUIRED, got ${tierProbe.status} ${tierCode}`);
  }
  log('EVIDENCE L2 tier gate is server-side at order creation (selfie prerequisite already satisfied)', { status: tierProbe.status, code: tierCode });

  if (failures.length > 0) {
    log('B11 PARTIAL — registered leg failures', { failures });
    throw new Error(`B11 PARTIAL: ${failures.join(' · ')}`);
  }
  log('B11 COMPLETE — GUEST BROWSE OPEN, ORDER GATE SERVER-SIDE, TIER GATE SERVER-SIDE');
}

main()
  .catch((e) => { console.error('B11 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
