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

/** A refusal is any non-2xx. A 2xx is only safe if it carries NONE of B's ids. */
function assertRefused(name: string, r: { status: number; raw: string }, secrets: string[], leaks: string[]) {
  if (r.status < 300) {
    const leaked = secrets.filter((s) => s && r.raw.includes(s));
    if (leaked.length > 0) {
      leaks.push(`${name}: HTTP ${r.status} LEAKED ${leaked.length} tenant-B identifier(s)`);
      return;
    }
    // 200 with an empty/scoped result is the correct "you have nothing here".
    log(`  ok ${name}`, { status: r.status, note: 'scoped-empty (no B data)' });
    return;
  }
  log(`  ok ${name}`, { status: r.status });
}

async function main() {
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
  const bCustomerUser = await prisma.user.create({
    data: {
      phone: `+59255${randomInt(100000, 999999)}`, firstName: MARK, lastName: 'Customer',
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

  const secrets = [bOrder.id, bVendor.id, bItem.id, bCustomerUser.id, bOrder.orderNumber, 'Tenant B secret address'];
  const leaks: string[] = [];

  // ── attacker: a REAL authenticated tenant-A customer + vendor owner ──────
  const aCustomerToken = await loginByOtp(CUSTOMER_PHONE);
  const aOwnerToken = await loginByOtp(OWNER_PHONE);
  log('attacker authenticated in tenant A (swift-default)');

  // ── 1. customer route class: read/act on B's order + vendor ──────────────
  log('ATTACK CLASS 1 — customer reads');
  assertRefused('GET /customer/orders/:bOrderId', await http('GET', `/customer/orders/${bOrder.id}`, undefined, aCustomerToken), secrets, leaks);
  assertRefused('GET /customer/orders (list must not contain B)', await http('GET', '/customer/orders?limit=50', undefined, aCustomerToken), secrets, leaks);
  assertRefused('POST /customer/orders/:bOrderId/cancel', await http('POST', `/customer/orders/${bOrder.id}/cancel`, { reason: 'attack' }, aCustomerToken), secrets, leaks);
  assertRefused('POST /customer/cart/items (B vendor+item)', await http('POST', '/customer/cart/items', { vendorId: bVendor.id, itemId: bItem.id, quantity: 1 }, aCustomerToken), secrets, leaks);
  assertRefused('GET /customer/vendors/:bVendorId', await http('GET', `/customer/vendors/${bVendor.id}`, undefined, aCustomerToken), secrets, leaks);

  // ── 2. vendor route class: A's owner acting on B's board ─────────────────
  log('ATTACK CLASS 2 — vendor board');
  assertRefused('GET /vendor/orders/:bOrderId', await http('GET', `/vendor/orders/${bOrder.id}`, undefined, aOwnerToken), secrets, leaks);
  assertRefused('PUT /vendor/orders/:bOrderId/accept', await http('PUT', `/vendor/orders/${bOrder.id}/accept`, {}, aOwnerToken), secrets, leaks);
  assertRefused('PUT /vendor/items/:bItemId', await http('PUT', `/vendor/items/${bItem.id}`, { basePrice: 1 }, aOwnerToken), secrets, leaks);
  assertRefused('GET /vendor/orders (list must not contain B)', await http('GET', '/vendor/orders?limit=50', undefined, aOwnerToken), secrets, leaks);

  // ── 3. public/browse class: the UNAUTHENTICATED catalog ─────────────────
  // A guest carries no tenant, so these were the only tenant-owned queries
  // running unscoped. That is now closed [F-226 / F-026-10]: public requests
  // resolve a tenant and scope to it, failing CLOSED when a multi-tenant
  // deployment has no rule. A leak here is a BREACH like any other — the
  // earlier verdict that treated it as a registered design choice was too
  // generous, and the adversarial review was right to say so.
  log('ATTACK CLASS 3 — public browse');
  assertRefused('GET /public/storefronts (directory)', await http('GET', '/public/storefronts?limit=50'), secrets, leaks);
  assertRefused('GET /public/storefronts/:bSlug (direct link)', await http('GET', `/public/storefronts/${bVendorSlug}`), secrets, leaks);

  // ── 4. unauthenticated + junk-token class ───────────────────────────────
  log('ATTACK CLASS 4 — tokenless / junk token');
  assertRefused('GET /customer/orders/:bOrderId tokenless', await http('GET', `/customer/orders/${bOrder.id}`), secrets, leaks);
  assertRefused('GET /customer/orders/:bOrderId junk token', await http('GET', `/customer/orders/${bOrder.id}`, undefined, 'not-a-real-token'), secrets, leaks);

  // ── 5. THE SAME ATTACKS UNDER CONCURRENT LOAD ───────────────────────────
  // An isolation bug that only shows under contention is still a breach: the
  // tenant store is per-request (AsyncLocalStorage), so overlapping requests
  // from two tenants are exactly the race worth proving.
  log('ATTACK CLASS 5 — 60 concurrent cross-tenant attacks interleaved with legitimate A traffic');
  const attacks = Array.from({ length: 30 }, () => [
    () => http('GET', `/customer/orders/${bOrder.id}`, undefined, aCustomerToken),
    () => http('GET', `/vendor/orders/${bOrder.id}`, undefined, aOwnerToken),
  ]).flat();
  const legit = Array.from({ length: 20 }, () => () => http('GET', '/customer/orders?limit=5', undefined, aCustomerToken));
  const results = await Promise.all([...attacks, ...legit].map((f) => f()));
  const breaches = results.filter((r) => r.status < 300 && secrets.some((s) => s && r.raw.includes(s)));
  if (breaches.length > 0) leaks.push(`concurrent: ${breaches.length}/${results.length} responses carried tenant-B data`);
  const legitOk = results.slice(attacks.length).every((r) => r.status === 200);
  if (!legitOk) leaks.push('concurrent: legitimate tenant-A traffic broke under load (isolation must not cost availability)');
  log('  concurrent sweep done', { requests: results.length, breaches: breaches.length, legitimateAllOk: legitOk });

  // ── 6. the wall is real, not an empty rig: B's data EXISTS ──────────────
  const bStillThere = await prisma.order.findUnique({ where: { id: bOrder.id }, select: { status: true, totalAmount: true } });
  if (!bStillThere) throw new Error('FAIL: the tenant-B fixture vanished — the attack proof would be vacuous');
  if (bStillThere.status !== 'PENDING') throw new Error(`FAIL: an attack MUTATED tenant B's order (status ${bStillThere.status})`);
  log('EVIDENCE tenant B intact and unmutated', bStillThere);

  // A leak on ANY class is a hard breach of the wall — the scenario fails.
  if (leaks.length > 0) throw new Error(`FAIL TENANT WALL:\n  - ${leaks.join('\n  - ')}`);
  log('EVIDENCE authenticated + tokenless + concurrent + public classes ALL refused — zero leaks');
  log('B12 COMPLETE — EVERY CROSS-TENANT ROUTE CLASS REFUSED, INCLUDING UNDER LOAD');
}

async function teardown() {
  // Own every row created (INV-14).
  const tenants = await prisma.tenant.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } });
  for (const t of tenants) {
    await prisma.order.deleteMany({ where: { tenantId: t.id } });
    await prisma.item.deleteMany({ where: { vendor: { tenantId: t.id } } });
    await prisma.category.deleteMany({ where: { vendor: { tenantId: t.id } } });
    await prisma.vendor.deleteMany({ where: { tenantId: t.id } });
    await prisma.vendorOwner.deleteMany({ where: { user: { tenantId: t.id } } });
    await prisma.customer.deleteMany({ where: { user: { tenantId: t.id } } });
    await prisma.user.deleteMany({ where: { tenantId: t.id } });
    await prisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
  }
  if (tenants.length > 0) log('teardown complete', { tenantsRemoved: tenants.length });
}

main()
  .catch((e) => { console.error('B12 FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { await teardown().catch((e) => console.error('teardown error:', e.message)); await prisma.$disconnect(); });
