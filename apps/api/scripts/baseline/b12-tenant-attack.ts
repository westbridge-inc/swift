/**
 * ELV-2 A12 — Scenario B12: TENANT ISOLATION ATTACK (live HTTP).
 *
 * The in-process suites already prove the Prisma scope extension, the RLS
 * wall, and admin scoping (74 tests). THIS proves the same thing the way an
 * attacker meets it: a REAL authenticated caller in tenant A, over HTTP,
 * against tenant B's real resource ids — across every route class — and then
 * the same attacks fired CONCURRENTLY against legitimate traffic, because an
 * isolation bug that only appears under load is still a breach.
 *
 * Rig setup creates a SYNTHETIC tenant B (marked `ELV2-B12`) with its own
 * vendor, item, customer and order. Everything it writes is torn down at the
 * end (INV-14: the script owns every row it creates).
 *
 * PASS = every cross-tenant read/write is refused (404/403/401 — never 200
 * carrying B's data), and no attack leaks B's identifiers into a response.
 *
 * Run: BASELINE_API=http://localhost:3020/api/v1 \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b12-tenant-attack.ts
 */
import { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';

const A = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const HEALTH = A.replace('/api/v1', '') + '/health';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';   // tenant A (swift-default)
const OWNER_PHONE = '+5925566000';      // tenant A vendor owner
const MARK = 'ELV2-B12';
let plantedTenantId: string | null = null;
let DATA_SECRETS: string[] = [];

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${A}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json, raw: JSON.stringify(json ?? {}) };
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

// [F-026-08] The refusal contract is EXACT, not "any non-2xx". A 5xx is a
// server fault, not a wall — it must fail the scenario. Allowed denials are
// 400 (malformed / not-permitted write), 401 (no/junk token), 403
// (authenticated but denied), 404 (existence hidden). A 2xx on a direct object
// is ALWAYS a breach (even {success:true} means the op was allowed).
//
// On a correct-status denial the body may echo identifiers the attacker
// SUPPLIED (a 404 "Order {id} not found" is harmless) — so the denial-body
// check looks only for B's DATA that was never in any request: the order
// NUMBER and the secret address. Cross-tenant WRITES are proven not to have
// landed by the DB-state snapshot at the end, not by the response body.
const OBJECT_DENIALS = [400, 401, 403, 404];

function assertObjectRefused(
  name: string, r: { status: number; raw: string }, dataSecrets: string[], leaks: string[],
  allowed: number[] = OBJECT_DENIALS,
) {
  if (r.status < 300) {
    leaks.push(`${name}: HTTP ${r.status} — a direct cross-tenant object access SUCCEEDED (body: ${r.raw.slice(0, 120)})`);
    return;
  }
  if (!allowed.includes(r.status)) {
    const why = r.status >= 500 ? 'server fault is not a wall' : 'outside the allowed denial contract';
    leaks.push(`${name}: HTTP ${r.status} — ${why} (${allowed.join('/')})`);
    return;
  }
  const leaked = dataSecrets.filter((s) => s && r.raw.includes(s));
  if (leaked.length > 0) { leaks.push(`${name}: HTTP ${r.status} denial body LEAKED tenant-B data (${leaked.length})`); return; }
  log(`  ok ${name}`, { status: r.status });
}

/** A LIST route may return 200 scoped-empty of B — checked for ANY B id in the
 *  body. A non-2xx must obey the contract; explicitly-allowed codes (e.g. the
 *  public catalog's 503 PUBLIC_TENANT_UNRESOLVED) pass BEFORE the generic 5xx
 *  guard, so a known-correct 503 is not miscounted as a server fault. */
function assertListScoped(
  name: string, r: { status: number; raw: string }, secrets: string[], leaks: string[],
  allowed: number[] = [401, 403, 404],
) {
  if (r.status < 300) {
    const leaked = secrets.filter((s) => s && r.raw.includes(s));
    if (leaked.length > 0) { leaks.push(`${name}: HTTP ${r.status} LEAKED ${leaked.length} tenant-B id(s)`); return; }
    log(`  ok ${name}`, { status: r.status, note: 'scoped-empty (no B data)' });
    return;
  }
  if (allowed.includes(r.status)) { log(`  ok ${name}`, { status: r.status }); return; }
  const why = r.status >= 500 ? 'unexpected server fault' : 'outside the allowed contract';
  leaks.push(`${name}: HTTP ${r.status} — ${why} (${allowed.join('/')})`);
}

/** Object-refusal shim: existing call sites pass the full secrets list; the
 *  denial-body check uses only the pure-data subset. */
function assertRefused(name: string, r: { status: number; raw: string }, _secrets: string[], leaks: string[]) {
  assertObjectRefused(name, r, DATA_SECRETS, leaks);
}

async function main(): Promise<string> {
  const h = await fetch(HEALTH).then((r) => r.status).catch(() => 0);
  if (h !== 200) throw new Error(`rig not healthy (${h})`);

  // ── rig setup: a synthetic TENANT B with its own world ───────────────────
  const tenantBId = `elv2-b12-${randomInt(100000, 999999)}`;
  const bPhone = `+59255${randomInt(100000, 999999)}`;
  await prisma.tenant.create({ data: { id: tenantBId, name: `${MARK} Tenant B`, slug: tenantBId, isActive: true } });
  const bUser = await prisma.user.create({
    data: {
      phone: bPhone, firstName: MARK, lastName: 'Owner',
      roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never,
      isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId: tenantBId,
    },
  });
  // VendorOwner carries no tenantId of its own — it inherits through its user.
  const bOwner = await prisma.vendorOwner.create({ data: { userId: bUser.id } });
  const bVendorSlug = `${tenantBId}-store`;
  const bVendor = await prisma.vendor.create({
    data: {
      ownerId: bOwner.id, tenantId: tenantBId, name: `${MARK} Store`, slug: bVendorSlug,
      vendorType: 'RESTAURANT', phone: bPhone, addressLine1: '1 Tenant B Road', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  const bCat = await prisma.category.create({ data: { vendorId: bVendor.id, name: `${MARK} Menu` } });
  const bItem = await prisma.item.create({
    data: { vendorId: bVendor.id, categoryId: bCat.id, name: `${MARK} Secret Dish`, basePrice: 1234, isAvailable: true, stockQuantity: 5 },
  });
  // [F-026-07] Tenant B's customer must be AUTHENTICABLE — the ALS cross-
  // request race can only be proven if B actually makes requests concurrently
  // with A. A random +59255… number can collide with the synthetic roster and
  // isn't in the dev OTP bypass set, so use a unique +59277… number and log
  // in through the same OTP path A uses.
  const bCustomerPhone = `+59277${randomInt(100000, 999999)}`;
  const bCustomerUser = await prisma.user.create({
    data: {
      phone: bCustomerPhone, firstName: MARK, lastName: 'Customer',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId: tenantBId,
      customer: { create: {} },
    },
  });
  const bOrder = await prisma.order.create({
    data: {
      orderNumber: `${MARK}-${randomInt(100000, 999999)}`, tenantId: tenantBId,
      customerId: bCustomerUser.id, vendorId: bVendor.id, status: 'PENDING', orderType: 'FOOD_DELIVERY',
      subtotalBase: 1234, subtotalMarkup: 0, subtotalCustomer: 1234, totalAmount: 1234, deliveryFee: 0,
      paymentMethod: 'CASH', fulfillment: 'PICKUP',
      deliveryAddress: 'Tenant B secret address', pickupAddress: '1 Tenant B Road',
      deliveryLat: 6.81, deliveryLng: -58.16,
    },
  });
  log('tenant B planted', { tenantBId, vendor: bVendor.id, order: bOrder.id, item: bItem.id });

  // [F-026-07] Authenticate tenant B — now the concurrency phase interleaves
  // two DIFFERENT tenant contexts through AsyncLocalStorage, which is the race
  // the load phase claims to test (the prior version only ever used A tokens).
  const bCustomerToken = await loginByOtp(bCustomerPhone);

  const secrets = [bOrder.id, bVendor.id, bItem.id, bCustomerUser.id, bOrder.orderNumber, 'Tenant B secret address'];
  // Pure B DATA that must never appear in ANY response — attacker never supplies these.
  DATA_SECRETS = [bOrder.orderNumber, 'Tenant B secret address'];
  const leaks: string[] = [];

  // ── attacker: a REAL authenticated tenant-A customer + vendor owner ──────
  const aCustomerToken = await loginByOtp(CUSTOMER_PHONE);
  const aOwnerToken = await loginByOtp(OWNER_PHONE);
  log('attacker authenticated in tenant A (swift-default)');

  // ── 1. customer route class: read/act on B's order + vendor ──────────────
  log('ATTACK CLASS 1 — customer reads');
  assertRefused('GET /customer/orders/:bOrderId', await http('GET', `/customer/orders/${bOrder.id}`, undefined, aCustomerToken), secrets, leaks);
  assertListScoped('GET /customer/orders (list must not contain B)', await http('GET', '/customer/orders?limit=50', undefined, aCustomerToken), secrets, leaks);
  assertRefused('POST /customer/orders/:bOrderId/cancel', await http('POST', `/customer/orders/${bOrder.id}/cancel`, { reason: 'attack' }, aCustomerToken), secrets, leaks);
  assertRefused('POST /customer/cart/items (B vendor+item)', await http('POST', '/customer/cart/items', { vendorId: bVendor.id, itemId: bItem.id, quantity: 1 }, aCustomerToken), secrets, leaks);
  assertRefused('GET /customer/vendors/:bVendorId', await http('GET', `/customer/vendors/${bVendor.id}`, undefined, aCustomerToken), secrets, leaks);

  // ── 2. vendor route class: A's owner acting on B's board ─────────────────
  log('ATTACK CLASS 2 — vendor board');
  assertRefused('GET /vendor/orders/:bOrderId', await http('GET', `/vendor/orders/${bOrder.id}`, undefined, aOwnerToken), secrets, leaks);
  assertRefused('PUT /vendor/orders/:bOrderId/accept', await http('PUT', `/vendor/orders/${bOrder.id}/accept`, {}, aOwnerToken), secrets, leaks);
  assertRefused('PUT /vendor/items/:bItemId', await http('PUT', `/vendor/items/${bItem.id}`, { basePrice: 1 }, aOwnerToken), secrets, leaks);
  assertListScoped('GET /vendor/orders (list must not contain B)', await http('GET', '/vendor/orders?limit=50', undefined, aOwnerToken), secrets, leaks);

  // ── 3. public/browse class: the UNAUTHENTICATED catalog ─────────────────
  // A guest carries no tenant, so these were the only tenant-owned queries
  // running unscoped. That is now closed [F-226 / F-026-10]: public requests
  // resolve a tenant and scope to it, failing CLOSED when a multi-tenant
  // deployment has no rule. A leak here is a BREACH like any other — the
  // earlier verdict that treated it as a registered design choice was too
  // generous, and the adversarial review was right to say so.
  log('ATTACK CLASS 3 — public browse');
  assertListScoped('GET /public/storefronts (directory)', await http('GET', '/public/storefronts?limit=50'), secrets, leaks, [404, 503]);
  assertListScoped('GET /public/storefronts/:bSlug (direct link)', await http('GET', `/public/storefronts/${bVendorSlug}`), secrets, leaks, [404, 503]);

  // ── 4. unauthenticated + junk-token class ───────────────────────────────
  log('ATTACK CLASS 4 — tokenless / junk token');
  assertRefused('GET /customer/orders/:bOrderId tokenless', await http('GET', `/customer/orders/${bOrder.id}`), secrets, leaks);
  assertRefused('GET /customer/orders/:bOrderId junk token', await http('GET', `/customer/orders/${bOrder.id}`, undefined, 'not-a-real-token'), secrets, leaks);

  // ── 5. THE SAME ATTACKS UNDER CONCURRENT LOAD ───────────────────────────
  // An isolation bug that only shows under contention is still a breach: the
  // tenant store is per-request (AsyncLocalStorage), so overlapping requests
  // from two tenants are exactly the race worth proving.
  // [F-026-07] Capture A's real order numbers once, so the interleave can
  // assert in BOTH directions: B must never see any of these under load.
  const aListBefore = await http('GET', '/customer/orders?limit=5', undefined, aCustomerToken);
  const aOrderNumbers: string[] = Array.isArray(aListBefore.json?.data)
    ? aListBefore.json.data.map((o: any) => o?.orderNumber).filter(Boolean)
    : [];

  log('ATTACK CLASS 5 — 60 concurrent cross-tenant attacks interleaved with legitimate A traffic');
  const attacks = Array.from({ length: 30 }, () => [
    () => http('GET', `/customer/orders/${bOrder.id}`, undefined, aCustomerToken),
    () => http('GET', `/vendor/orders/${bOrder.id}`, undefined, aOwnerToken),
  ]).flat();
  // [F-026-07] Legit traffic from BOTH tenants, interleaved: A reading its own
  // list and B reading its own list at the same moment is exactly the ALS race
  // — if a request ever resolved another tenant's context, B would see A's
  // data or A would see B's. Each is tagged so a cross-context leak is caught
  // in EITHER direction, not just A-reads-B.
  const legitA = Array.from({ length: 20 }, () => () =>
    http('GET', '/customer/orders?limit=5', undefined, aCustomerToken).then((r) => ({ ...r, who: 'A' as const })));
  const legitB = Array.from({ length: 20 }, () => () =>
    http('GET', '/customer/orders?limit=5', undefined, bCustomerToken).then((r) => ({ ...r, who: 'B' as const })));
  const attackTagged = attacks.map((f) => () => f().then((r) => ({ ...r, who: 'attack' as const })));
  // Shuffle so A, B and attack requests actually overlap rather than run in blocks.
  const mixed = [...attackTagged, ...legitA, ...legitB]
    .map((f) => ({ f, k: randomInt(0, 1_000_000) }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.f);
  const results = await Promise.all(mixed.map((f) => f()));
  // Now that tenant B authenticates and reads its OWN data, exclude B's own
  // responses from the blanket secrets check — B seeing B's order is correct,
  // not a leak. The directional checks below are the precise cross-tenant test.
  const breaches = results.filter((r) => r.who !== 'B' && r.status < 300 && secrets.some((s) => s && r.raw.includes(s)));
  if (breaches.length > 0) leaks.push(`concurrent: ${breaches.length}/${results.length} non-B responses carried tenant-B data`);
  // A must never see B's order number and vice-versa — check both directions.
  const bLeakedToA = results.filter((r) => r.who === 'A' && r.raw.includes(bOrder.orderNumber));
  const aLeakedToB = results.filter((r) => r.who === 'B' && aOrderNumbers.some((n) => n && r.raw.includes(n)));
  if (bLeakedToA.length > 0) leaks.push(`concurrent: ${bLeakedToA.length} tenant-A responses carried tenant-B's order under load (ALS race)`);
  if (aLeakedToB.length > 0) leaks.push(`concurrent: ${aLeakedToB.length} tenant-B responses carried tenant-A data under load (ALS race)`);
  const legitOk = results.filter((r) => r.who !== 'attack').every((r) => r.status === 200);
  if (!legitOk) leaks.push('concurrent: legitimate two-tenant traffic broke under load (isolation must not cost availability)');
  log('  concurrent sweep done', { requests: results.length, breaches: breaches.length, bLeakedToA: bLeakedToA.length, aLeakedToB: aLeakedToB.length, legitimateAllOk: legitOk });

  // ── 6. the wall is real, not an empty rig: B's data EXISTS and is UNWRITTEN.
  // [F-026-08] A cross-tenant write can return {success:true} and slip past a
  // body-only check — so verify the DATABASE, not the response. The item was
  // attacked with basePrice:1; assert its price and B's order are unchanged.
  const bStillThere = await prisma.order.findUnique({ where: { id: bOrder.id }, select: { status: true, totalAmount: true } });
  if (!bStillThere) throw new Error('FAIL: the tenant-B fixture vanished — the attack proof would be vacuous');
  if (bStillThere.status !== 'PENDING') throw new Error(`FAIL: an attack MUTATED tenant B's order (status ${bStillThere.status})`);
  if (Number(bStillThere.totalAmount) !== 1234) throw new Error(`FAIL: an attack MUTATED tenant B's order total (${bStillThere.totalAmount})`);
  const bItemNow = await prisma.item.findUnique({ where: { id: bItem.id }, select: { basePrice: true } });
  if (!bItemNow) throw new Error('FAIL: the tenant-B item fixture vanished');
  if (Number(bItemNow.basePrice) !== 1234) throw new Error(`FAIL: the PUT /vendor/items attack MUTATED tenant B's item price to ${bItemNow.basePrice}`);
  log('EVIDENCE tenant B intact and unmutated (order + item price verified in DB)', { order: bStillThere, itemPrice: Number(bItemNow.basePrice) });

  // A leak on ANY class is a hard breach of the wall — the scenario fails.
  if (leaks.length > 0) throw new Error(`FAIL TENANT WALL:\n  - ${leaks.join('\n  - ')}`);
  log('EVIDENCE authenticated + tokenless + concurrent + public classes ALL refused — zero leaks');
  log('B12 COMPLETE — EVERY CROSS-TENANT ROUTE CLASS REFUSED, INCLUDING UNDER LOAD');
  return tenantBId;
}

// [F-026-09] Teardown owns exactly THIS run's tenant (by id, not a shared
// marker prefix that could delete a concurrent run's fixtures), VERIFIES the
// tenant is gone, and signals failure to the caller so a partial/FK-blocked
// cleanup cannot exit green while fixtures linger.
async function teardown(tenantBId: string): Promise<void> {
  await prisma.order.deleteMany({ where: { tenantId: tenantBId } });
  await prisma.item.deleteMany({ where: { vendor: { tenantId: tenantBId } } });
  await prisma.category.deleteMany({ where: { vendor: { tenantId: tenantBId } } });
  await prisma.vendor.deleteMany({ where: { tenantId: tenantBId } });
  await prisma.vendorOwner.deleteMany({ where: { user: { tenantId: tenantBId } } });
  await prisma.customer.deleteMany({ where: { user: { tenantId: tenantBId } } });
  await prisma.user.deleteMany({ where: { tenantId: tenantBId } });
  await prisma.tenant.delete({ where: { id: tenantBId } });
  const survivor = await prisma.tenant.findUnique({ where: { id: tenantBId }, select: { id: true } });
  if (survivor) throw new Error(`teardown INCOMPLETE — tenant ${tenantBId} still present`);
  log('teardown complete', { tenantBId });
}

main()
  .then((id) => { plantedTenantId = id; })
  .catch((e) => { console.error('B12 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    if (plantedTenantId) {
      // [F-026-09] A teardown failure FAILS the run — never green with residue.
      await teardown(plantedTenantId).catch((e) => { console.error('B12 TEARDOWN FAILED:', e.message); process.exitCode = 1; });
    }
    await prisma.$disconnect();
  });
