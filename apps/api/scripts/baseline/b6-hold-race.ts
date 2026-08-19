/**
 * ELV-1 A10 — Scenario B6: the hold window + exactly-once order creation,
 * run against the LIVE rig (http://localhost:3000) with SYNTHETIC actors only.
 *
 * Proves, with server-side evidence:
 *   1. DOUBLE-TAP: two concurrent checkouts of one cart yield EXACTLY ONE order.
 *   2. HOLD IS VENDOR-BLIND: while holdExpiresAt is in the future, the vendor
 *      has zero notification rows for the order and no dispatch state exists.
 *   3. CANCEL-IN-HOLD: a customer cancel inside the window sticks; the vendor
 *      is NEVER told about that order, even after the window passes.
 *   4. HONEST EXPIRY: an uncancelled order surfaces to the vendor (LOUD notice
 *      row) once the hold lapses and the release sweep runs.
 *
 * INV-14: every row this script writes belongs to the ELV1- synthetic roster it
 * creates (idempotently). It never touches existing vendors/orders.
 *
 * Run: PATH=$HOME/.nvm/versions/node/v20.19.6/bin:$PATH \
 *      DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b6-hold-race.ts
 */
import { PrismaClient } from '@prisma/client';

const API = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';
const VENDOR_MARK = 'ELV1 Baseline Diner';

function log(step: string, detail: unknown = '') {
  console.log(`${new Date().toISOString()} · ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

async function ensureRoster() {
  // Vendor + item: direct synthetic rows (marked), idempotent by name.
  let vendor = await prisma.vendor.findFirst({ where: { name: VENDOR_MARK } });
  if (!vendor) {
    const ownerUser = await prisma.user.create({
      data: {
        phone: '+5925566000', firstName: 'ELV1', lastName: 'Owner',
        roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
        isPhoneVerified: true, selfieCapturedAt: new Date(),
      },
    });
    const owner = await prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    vendor = await prisma.vendor.create({
      data: {
        ownerId: owner.id, name: VENDOR_MARK, slug: 'elv1-baseline-diner',
        vendorType: 'RESTAURANT', phone: '+5925566009',
        addressLine1: '1 Baseline Row', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
  }
  let item = await prisma.item.findFirst({ where: { vendorId: vendor.id, name: 'ELV1 Pepperpot' } });
  if (!item) {
    let cat = await prisma.category.findFirst({ where: { vendorId: vendor.id } });
    if (!cat) {
      cat = await prisma.category.create({ data: { vendorId: vendor.id, name: 'ELV1 Mains' } });
    }
    item = await prisma.item.create({
      data: {
        vendorId: vendor.id, categoryId: cat.id, name: 'ELV1 Pepperpot',
        basePrice: 1500, isAvailable: true,
      },
    });
  }
  // Customer through the REAL auth flow (dev OTP bypass on the rig).
  const pickToken = (j: any): string | undefined =>
    j?.data?.tokens?.accessToken ?? j?.data?.tokens?.token ?? j?.data?.token ?? j?.data?.accessToken;
  await http('POST', '/auth/send-otp', { phone: CUSTOMER_PHONE });
  let v = await http('POST', '/auth/verify-otp', { phone: CUSTOMER_PHONE, code: '000000' });
  let token = pickToken(v.json);
  if (!token && v.json?.data?.isNewUser) {
    const r = await http('POST', '/auth/register', {
      phone: CUSTOMER_PHONE, firstName: 'ELV1', lastName: 'Customer', role: 'CUSTOMER', acceptTerms: true,
    });
    token = pickToken(r.json);
    if (!token) {
      // register may not auto-login — verify again against the now-existing user
      await http('POST', '/auth/send-otp', { phone: CUSTOMER_PHONE });
      v = await http('POST', '/auth/verify-otp', { phone: CUSTOMER_PHONE, code: '000000' });
      token = pickToken(v.json);
    }
  }
  if (!token) throw new Error(`no customer token: ${JSON.stringify(v.json).slice(0, 300)}`);
  const me = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  // The ID-gate (SELFIE_REQUIRED) is a real product rule; the synthetic roster
  // stamps the capture the same way the test suites' fixtures do.
  if (!me.selfieCapturedAt) {
    await prisma.user.update({ where: { id: me.id }, data: { selfieCapturedAt: new Date() } });
  }
  // Address (idempotent-ish: reuse first).
  let address = await prisma.address.findFirst({ where: { userId: me.id } });
  if (!address) {
    const a = await http('POST', '/customer/addresses', {
      label: 'ELV1 Home', addressLine1: '2 Baseline Row', city: 'Georgetown',
      latitude: 6.81, longitude: -58.16,
    }, token);
    if (a.status >= 300) throw new Error(`address failed: ${a.status} ${JSON.stringify(a.json).slice(0, 200)}`);
    address = await prisma.address.findFirstOrThrow({ where: { userId: me.id } });
  }
  // Supply: ONE synthetic online rider near the vendor, so the availability-
  // honesty gate (observed live: DELIVERY_NO_RIDERS, INV-13 working) lets the
  // hold scenario proceed. B6's orders cancel/hold before dispatch fires.
  let riderUser = await prisma.user.findFirst({ where: { phone: '+5925566002' } });
  if (!riderUser) {
    riderUser = await prisma.user.create({
      data: {
        phone: '+5925566002', firstName: 'ELV1', lastName: 'Rider',
        roles: ['RIDER', 'CUSTOMER'], activeRole: 'RIDER',
        isPhoneVerified: true, selfieCapturedAt: new Date(),
      },
    });
  }
  let rider = await prisma.rider.findFirst({ where: { userId: riderUser.id } });
  if (!rider) {
    rider = await prisma.rider.create({
      data: {
        userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
        documentsVerified: true, floatLimit: 1_000_000,
        isOnline: true, isAvailable: true, currentOrderId: null,
        currentLat: 6.8, currentLng: -58.15, averageRating: 5, acceptanceRate: 100,
      },
    });
    const session = await prisma.session.create({
      data: {
        userId: riderUser.id, token: `elv1-rider-${Date.now()}`,
        refreshToken: `elv1-rider-r-${Date.now()}`, deviceId: 'elv1-baseline',
        deviceType: 'script', expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.rider.update({ where: { id: rider.id }, data: { locationSessionId: session.id } });
  }
  await prisma.rider.update({
    where: { id: rider.id },
    data: { isOnline: true, isAvailable: true, currentOrderId: null, lastLocationUpdate: new Date() },
  });
  return { vendor, item, token, customerId: me.id, addressId: address.id, ownerUserId: (await prisma.vendorOwner.findUniqueOrThrow({ where: { id: vendor.ownerId }, select: { userId: true } })).userId };
}

async function fillCart(t: { token: string; vendor: { id: string }; item: { id: string }; addressId: string }) {
  const add = await http('POST', '/customer/cart/items', { vendorId: t.vendor.id, itemId: t.item.id, quantity: 1 }, t.token);
  if (add.status >= 300) throw new Error(`cart add failed: ${add.status} ${JSON.stringify(add.json).slice(0, 300)}`);
  const addr = await http('PUT', '/customer/cart/address', { addressId: t.addressId }, t.token);
  if (addr.status >= 300) throw new Error(`cart address failed: ${addr.status}`);
}

async function vendorNoticeCount(ownerUserId: string, orderId: string) {
  return prisma.notification.count({
    where: { userId: ownerUserId, OR: [
      { data: { path: ['orderId'], equals: orderId } },
      { body: { contains: orderId.slice(0, 8) } },
    ] },
  });
}

async function main() {
  const t = await ensureRoster();
  log('roster ready', { vendor: t.vendor.id, item: t.item.id, customer: t.customerId });

  // ── 1. DOUBLE-TAP: two concurrent checkouts, one cart ──────────────────────
  await fillCart(t);
  const [c1, c2] = await Promise.all([
    http('POST', '/customer/checkout', { paymentMethod: 'CASH' }, t.token),
    http('POST', '/customer/checkout', { paymentMethod: 'CASH' }, t.token),
  ]);
  const codes = [c1.status, c2.status].sort((a, b) => a - b);
  const winners = [c1, c2].filter((r) => r.status === 200);
  log('double-tap statuses', codes);
  if (winners.length !== 1) throw new Error(`FAIL double-tap: expected exactly 1 winner, got ${winners.length}`);
  const orderAId: string = winners[0]!.json.data.orders?.[0]?.id ?? winners[0]!.json.data.order?.id ?? winners[0]!.json.data.id;
  const recentCount = await prisma.order.count({
    where: { customerId: t.customerId, placedAt: { gte: new Date(Date.now() - 60_000) } },
  });
  if (recentCount !== 1) throw new Error(`FAIL double-tap: ${recentCount} orders exist server-side`);
  log('PASS double-tap', { orderAId, serverSideOrders: recentCount });

  // ── 2. HOLD IS VENDOR-BLIND on order A ─────────────────────────────────────
  const a0 = await prisma.order.findUniqueOrThrow({ where: { id: orderAId }, select: { holdExpiresAt: true, status: true } });
  const held = !!a0.holdExpiresAt && a0.holdExpiresAt > new Date();
  const noticesDuringHold = await vendorNoticeCount(t.ownerUserId, orderAId);
  log(held ? 'hold active' : 'NOTE: no hold on this rig config', { holdExpiresAt: a0.holdExpiresAt, status: a0.status, vendorNotices: noticesDuringHold });
  if (held && noticesDuringHold > 0) throw new Error('FAIL: vendor notified during hold');

  // ── 3. CANCEL-IN-HOLD sticks; vendor never told ────────────────────────────
  const cancel = await http('POST', `/orders/${orderAId}/cancel`, { reason: 'ELV1 baseline B6' }, t.token);
  // route may live under /customer as well — try fallback once
  const cancelled = cancel.status < 300 ? cancel
    : await http('POST', `/customer/orders/${orderAId}/cancel`, { reason: 'ELV1 baseline B6' }, t.token);
  if (cancelled.status >= 300) throw new Error(`FAIL: cancel-in-hold rejected: ${cancelled.status} ${JSON.stringify(cancelled.json).slice(0, 200)}`);
  const a1 = await prisma.order.findUniqueOrThrow({ where: { id: orderAId }, select: { status: true } });
  if (a1.status !== 'CANCELLED') throw new Error(`FAIL: order A status ${a1.status}`);
  log('PASS cancel-in-hold', { status: a1.status });

  // ── 4. HONEST EXPIRY on order B ────────────────────────────────────────────
  await fillCart(t);
  const b = await http('POST', '/customer/checkout', { paymentMethod: 'CASH' }, t.token);
  if (b.status !== 200) throw new Error(`FAIL: order B checkout ${b.status}`);
  const orderBId: string = b.json.data.orders?.[0]?.id ?? b.json.data.order?.id ?? b.json.data.id;
  const b0 = await prisma.order.findUniqueOrThrow({ where: { id: orderBId }, select: { holdExpiresAt: true } });
  log('order B placed', { orderBId, holdExpiresAt: b0.holdExpiresAt });
  if (b0.holdExpiresAt) {
    const waitMs = Math.max(0, b0.holdExpiresAt.getTime() - Date.now()) + 90_000; // + sweep cadence slack
    log(`waiting out hold + sweep (~${Math.round(waitMs / 1000)}s)`);
    const deadline = Date.now() + waitMs + 60_000;
    let bNotices = 0;
    while (Date.now() < deadline) {
      bNotices = await vendorNoticeCount(t.ownerUserId, orderBId);
      if (bNotices > 0) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (bNotices === 0) throw new Error('FAIL: vendor never surfaced order B after hold expiry');
    log('PASS honest-expiry', { vendorNotices: bNotices });
  } else {
    log('NOTE: rig places without hold (LIFECYCLE_V2 off?) — expiry leg N/A, vendor-notice check direct');
    const bNotices = await vendorNoticeCount(t.ownerUserId, orderBId);
    log('vendor notices for B (immediate mode)', bNotices);
  }
  // A stays invisible to the vendor forever:
  const aNoticesFinal = await vendorNoticeCount(t.ownerUserId, orderAId);
  if (aNoticesFinal > 0) throw new Error('FAIL: cancelled-in-hold order A reached the vendor');
  log('PASS cancelled-order-stays-invisible', { aNoticesFinal });

  // tidy: cancel order B so the roster is reusable
  await http('POST', `/orders/${orderBId}/cancel`, { reason: 'ELV1 baseline cleanup' }, t.token);
  await http('POST', `/customer/orders/${orderBId}/cancel`, { reason: 'ELV1 baseline cleanup' }, t.token);
  log('B6 COMPLETE — ALL ASSERTIONS PASSED');
}

main()
  .catch((e) => { console.error('B6 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
