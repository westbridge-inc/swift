/**
 * ELV-2 A12 — Scenario B4: ITEM-UNAVAILABLE — vendor refunds a line, the
 * customer is told, totals recompute, stock restores, the remainder proceeds.
 *
 * Roster: adds a synthetic SUPERMARKET (picking-gated vertical) beside the
 * baseline diner — supermarkets are where "don't have this" lives.
 *
 * Run: DATABASE_URL=postgresql://swift:swift@localhost:5434/swift \
 *      npx tsx scripts/baseline/b4-item-unavailable.ts
 */
import { Prisma, PrismaClient } from '@prisma/client';

const API = process.env['BASELINE_API'] ?? 'http://localhost:3000/api/v1';
const prisma = new PrismaClient();
const CUSTOMER_PHONE = '+5925566001';
const MART_OWNER_PHONE = '+5925566003';
const MART_MARK = 'ELV1 Baseline Mart';

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

const pickToken = (j: any): string | undefined =>
  j?.data?.tokens?.accessToken ?? j?.data?.tokens?.token ?? j?.data?.token ?? j?.data?.accessToken;

async function loginByOtp(phone: string): Promise<string> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await http('POST', '/auth/send-otp', { phone });
    const v = await http('POST', '/auth/verify-otp', { phone, code: '000000' });
    let t = pickToken(v.json);
    if (!t && v.json?.data?.isNewUser) {
      const r = await http('POST', '/auth/register', { phone, firstName: 'ELV1', lastName: 'MartOwner', role: 'VENDOR', acceptTerms: true });
      t = pickToken(r.json);
    }
    if (t) return t;
    if (attempt === 6) throw new Error(`no token for ${phone}: ${JSON.stringify(v.json).slice(0,150)}`);
    await new Promise((r) => setTimeout(r, 8000)); // real limiter — always wait between attempts
  }
  throw new Error('unreachable');
}

async function ensureMart() {
  let vendor = await prisma.vendor.findFirst({ where: { name: MART_MARK } });
  if (!vendor) {
    let ownerUser = await prisma.user.findFirst({ where: { phone: MART_OWNER_PHONE } });
    if (!ownerUser) {
      ownerUser = await prisma.user.create({
        data: { phone: MART_OWNER_PHONE, firstName: 'ELV1', lastName: 'MartOwner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
      });
    }
    let owner = await prisma.vendorOwner.findFirst({ where: { userId: ownerUser.id } });
    if (!owner) owner = await prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    vendor = await prisma.vendor.create({
      data: {
        ownerId: owner.id, name: MART_MARK, slug: 'elv1-baseline-mart', vendorType: 'SUPERMARKET',
        phone: '+5925566008', addressLine1: '3 Baseline Row', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
  }
  let cat = await prisma.category.findFirst({ where: { vendorId: vendor.id } });
  if (!cat) cat = await prisma.category.create({ data: { vendorId: vendor.id, name: 'ELV1 Groceries' } });
  const wantItems: [string, number, number][] = [['ELV1 Rice 5kg', 2500, 10], ['ELV1 Milk 1L', 700, 10]];
  const items: any[] = [];
  for (const [name, price, stock] of wantItems) {
    let it = await prisma.item.findFirst({ where: { vendorId: vendor.id, name } });
    if (!it) it = await prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name, basePrice: price, isAvailable: true, stockQuantity: stock } });
    // [F-024-17] RERUN SAFETY: checkout decrements BOTH lines but only the
    // refunded one is restocked, so the surviving line was consumed on every
    // clean run — the fixture depleted itself after ~10 runs and B4 would fail
    // on its own roster. Top the synthetic stock back up each run.
    else if ((it.stockQuantity ?? 0) < stock) {
      it = await prisma.item.update({ where: { id: it.id }, data: { stockQuantity: stock, isAvailable: true } });
    }
    items.push(it);
  }
  return { vendor, items };
}

async function main() {
  const { vendor, items } = await ensureMart();
  const customer = await prisma.user.findFirstOrThrow({ where: { phone: CUSTOMER_PHONE } });
  const customerToken = await loginByOtp(CUSTOMER_PHONE);
  const ownerToken = await loginByOtp(MART_OWNER_PHONE);
  const address = await prisma.address.findFirstOrThrow({ where: { userId: customer.id } });
  log('roster ready', { vendor: vendor.id, items: items.map((i) => i.name) });

  // ── 1. two-line PICKUP order ──────────────────────────────────────────────
  for (const it of items) {
    const r = await http('POST', '/customer/cart/items', { vendorId: vendor.id, itemId: it.id, quantity: 1 }, customerToken);
    if (r.status >= 300) throw new Error(`cart add ${it.name}: ${r.status} ${JSON.stringify(r.json).slice(0,200)}`);
  }
  await http('PUT', '/customer/cart/address', { addressId: address.id }, customerToken);
  const co = await http('POST', '/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendor.id]: 'PICKUP' } }, customerToken);
  if (co.status !== 200) throw new Error(`checkout ${co.status}: ${JSON.stringify(co.json).slice(0, 300)}`);
  const orderId: string = co.json.data.orders?.[0]?.id ?? co.json.data.order?.id ?? co.json.data.id;
  const o0 = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { totalAmount: true, holdExpiresAt: true, subtotalBase: true, subtotalCustomer: true },
  });
  log('EVIDENCE placed 2 lines', { orderId, total: String(o0.totalAmount) });

  // ── 2. hold ff → vendor accepts ───────────────────────────────────────────
  if (o0.holdExpiresAt && o0.holdExpiresAt > new Date()) {
    await prisma.order.update({ where: { id: orderId }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const st = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
      if (st === 'PENDING') break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const acc = await http('PUT', `/vendor/orders/${orderId}/accept`, {}, ownerToken);
  if (acc.status >= 300) throw new Error(`accept ${acc.status}: ${JSON.stringify(acc.json).slice(0,200)}`);

  // ── 3. refund one line (out of stock) ─────────────────────────────────────
  const lines = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true, itemId: true, totalCustomer: true, totalBase: true, name: true } });
  if (lines.length !== 2) throw new Error(`expected 2 lines, got ${lines.length}`);
  const victim = lines.find((l) => l.name === 'ELV1 Milk 1L') ?? lines[1]!;
  const stockBefore = (await prisma.item.findUniqueOrThrow({ where: { id: victim.itemId! }, select: { stockQuantity: true } })).stockQuantity;
  const refundStartedAt = new Date();
  const rf = await http('POST', `/vendor/orders/${orderId}/items/${victim.id}/refund-line`, {}, ownerToken);
  if (rf.status >= 300) throw new Error(`refund-line ${rf.status}: ${JSON.stringify(rf.json).slice(0,250)}`);

  // ── 4. evidence: totals shrink · stock restored · customer told ───────────
  // [F-024-14] EXACT money: Prisma Decimals compared as scaled integers (minor
  // units), never JS floats, and EVERY affected column — a component total can
  // be corrupted while the grand total happens to land right.
  const o1 = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { totalAmount: true, subtotalBase: true, subtotalCustomer: true },
  });
  const minor = (d: unknown) => BigInt(new Prisma.Decimal(d as never).times(100).toFixed(0));
  const expectedDrop = minor(victim.totalCustomer);
  const actualDrop = minor(o0.totalAmount) - minor(o1.totalAmount);
  if (actualDrop !== expectedDrop) throw new Error(`FAIL recompute: dropped ${actualDrop}, expected ${expectedDrop} (minor units)`);
  const subCustomerDrop = minor(o0.subtotalCustomer) - minor(o1.subtotalCustomer);
  if (subCustomerDrop !== expectedDrop) throw new Error(`FAIL component: subtotalCustomer dropped ${subCustomerDrop}, expected ${expectedDrop}`);
  // [F-026-24] subtotalBase must drop by the victim line's EXACT totalBase, not
  // merely "some positive amount ≤ the customer drop" — a range check lets a
  // component corruption pass while the grand/customer totals happen to be
  // right. Compare to the line's own base total.
  const expectedBaseDrop = minor(victim.totalBase);
  const subBaseDrop = minor(o0.subtotalBase) - minor(o1.subtotalBase);
  if (subBaseDrop !== expectedBaseDrop) throw new Error(`FAIL component: subtotalBase dropped ${subBaseDrop}, expected ${expectedBaseDrop} (the refunded line's totalBase, minor units)`);
  const victimAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: victim.id }, select: { subStatus: true } });
  if (victimAfter.subStatus !== 'REFUNDED') throw new Error(`FAIL: refunded line is ${victimAfter.subStatus}, expected REFUNDED`);
  const stockAfter = (await prisma.item.findUniqueOrThrow({ where: { id: victim.itemId! }, select: { stockQuantity: true } })).stockQuantity;
  if ((stockAfter ?? 0) !== (stockBefore ?? 0) + 1) throw new Error(`FAIL restock: ${stockBefore} → ${stockAfter}`);
  // [F-024-13] The notification must be THE line-refund one — correlated by
  // customer, type, orderId, kind and lineId. A count delta accepts any
  // unrelated notice that happened to land in the window.
  const refundNotices = await prisma.notification.count({
    where: {
      userId: customer.id, type: 'ORDER_UPDATE', createdAt: { gte: refundStartedAt },
      AND: [
        { data: { path: ['kind'], equals: 'line_refunded' } as never },
        { data: { path: ['orderId'], equals: orderId } as never },
        { data: { path: ['lineId'], equals: victim.id } as never },
      ],
    },
  });
  if (refundNotices !== 1) throw new Error(`FAIL: ${refundNotices} correlated line_refunded notices for this line, expected exactly 1`);
  log('EVIDENCE line refunded', {
    dropMinor: String(actualDrop), subtotalCustomerDropMinor: String(subCustomerDrop), subtotalBaseDropMinor: String(subBaseDrop),
    lineSubStatus: victimAfter.subStatus, stock: `${stockBefore}→${stockAfter}`, correlatedNotices: refundNotices,
  });

  // ── 5. the remainder proceeds: pick the surviving line → ready → code done ─
  const survivor = lines.find((l) => l.id !== victim.id)!;
  // [F-026-29] Assert the leg; tolerate only a proven auto-advance.
  const prep = await http('PUT', `/vendor/orders/${orderId}/preparing`, {}, ownerToken);
  if (prep.status >= 300) {
    const st = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
    const advanced = ['PREPARING', 'READY_FOR_PICKUP', 'READY', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'COMPLETED'].includes(st);
    if (!advanced) throw new Error(`FAIL preparing leg: ${prep.status} and the order is still ${st} — not an auto-advance (${JSON.stringify(prep.json).slice(0, 200)})`);
    log('NOTE preparing already advanced', { status: prep.status, orderStatus: st });
  }
  const picked = await http('PUT', `/vendor/orders/${orderId}/items/${survivor.id}/picked`, { picked: true }, ownerToken);
  if (picked.status >= 300) throw new Error(`picked ${picked.status}: ${JSON.stringify(picked.json).slice(0,200)}`);
  const rdy = await http('PUT', `/vendor/orders/${orderId}/ready`, {}, ownerToken);
  if (rdy.status >= 300) throw new Error(`ready ${rdy.status}: ${JSON.stringify(rdy.json).slice(0,250)}`);
  const code = (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { pickupCode: true } })).pickupCode;
  const done = await http('PUT', `/vendor/orders/${orderId}/complete-pickup`, { code }, ownerToken);
  if (done.status >= 300) throw new Error(`complete ${done.status}: ${JSON.stringify(done.json).slice(0,200)}`);
  const oF = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, totalAmount: true } });
  // [F-024-15] A 2xx completion response is not completion — assert the
  // terminal state, or a regression that 200s while leaving the order open
  // still prints "B4 COMPLETE".
  if (oF.status !== 'COMPLETED') throw new Error(`FAIL: remainder ended in ${oF.status}, expected COMPLETED`);
  if (minor(oF.totalAmount) !== minor(o1.totalAmount)) throw new Error(`FAIL: total moved after the refund (${String(o1.totalAmount)} → ${String(oF.totalAmount)})`);
  log('EVIDENCE remainder completed', { status: oF.status, finalTotal: String(oF.totalAmount) });

  log('B4 COMPLETE — LINE REFUND RECOMPUTES, RESTOCKS, NOTIFIES; REMAINDER PROCEEDS');
}

main()
  .catch((e) => { console.error('B4 FAILED:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
