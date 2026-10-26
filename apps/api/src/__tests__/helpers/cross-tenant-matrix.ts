import type { FastifyInstance, HTTPMethods, InjectOptions } from 'fastify';
import type { PrismaClient, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { sessionCredentialDigest } from '../../lib/session-credential';

// ---------------------------------------------------------------------------
// [row 300 · T3] The route-table cross-tenant attack matrix.
//
// Every route the API mounts is fired by callers from OTHER tenants — the
// store-review fiction (a REVIEW customer, rider and driver) and a second
// tenant's store owner and administrator — at the REAL objects of the
// production tenant: path ids, the store header, query and body fields all
// name a production order, store, item, account, address, ticket, SOS,
// chat room, document and so on. Two things must hold for every request:
//   1. no 2xx answer carries production data (every production fixture
//      carries a marker string; a body containing it is a leak), and
//   2. after the whole sweep, no production row has changed (a digest of
//      every fixture row, taken before and after).
// A money or platform admin route answers 202 APPROVAL_REQUIRED before its
// handler runs, so the attacker's ask is APPROVED by a second administrator of
// the attacker's own tenant and re-sent with the approval: the handler itself
// is then fired at the production objects too (the approval leg).
// The same sweep runs on the owner login and on the walled login (the
// production CONTRACT posture), from two suites that share this harness.
// ---------------------------------------------------------------------------

export const PRODUCTION_TENANT = 'swift-default';

/**
 * The REAL app (buildApp, as server.ts builds it) and its route table, collected by its onRoute census:
 * every plugin, prefix and hook production mounts (tenant header scope, multipart, the public, market,
 * discovery, billing and legal families), so a newly mounted route joins the matrix with no list to keep.
 * The suite raises RATE_LIMIT_MAX before building: the global per-user ceiling is not under test here,
 * and at 200/min it would answer most of a 600-route sweep with 429. It also sets RUN_WORKERS=0: the
 * in-process scheduler would page the seeded ACTIVE SOS on its own (a real system write to a production
 * row, mid-sweep) and blur the one thing measured here, what a REQUEST can do. Queued work is the job
 * suites' to judge; here it stays queued.
 */
export async function buildMatrixApp(): Promise<{ app: FastifyInstance; routes: Array<{ method: string; url: string }> }> {
  const { buildApp } = await import('../../app');
  const routes: Array<{ method: string; url: string }> = [];
  const app = await buildApp({
    onRoute: (route) => {
      for (const m of (Array.isArray(route.method) ? route.method : [route.method]) as HTTPMethods[]) {
        if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m, url: route.url });
      }
    },
  });
  await app.ready();
  return { app, routes };
}

export interface World {
  run: string;
  mark: string;
  review: string;
  tenantB: string;
  victim: {
    customer: string; owner: string; riderUser: string; driverUser: string;
    rider: string; driver: string; vendor: string; vendorOwner: string; category: string; item: string;
    address: string; order: string; delivered: string; taxi: string; courier: string; orderItem: string;
    rating: string; ticket: string; sos: string; room: string; document: string; staffUser: string;
    optionGroup: string; option: string; cart: string; cartItem: string; booking: string; subscription: string; claim: string;
  };
  attackers: Array<{ label: string; userId: string; role: UserRole }>;
  /** [REVIEW-M #2069 S3-1] An attacker's same-tenant colleague who approves its two-person asks (the approval leg). */
  approvers: Record<string, { userId: string; role: UserRole }>;
  cleanup: () => Promise<void>;
}

const phone = (run: string, n: number) => `+59210${String(Number.parseInt(run.slice(0, 6), 16) % 100000).padStart(5, '0')}${String(n).padStart(2, '0')}`;

/**
 * The word an `:kind` / `:queue` URL segment takes. Held in a constant on purpose: the notification
 * censuses (alert-class-census, mobile notification-router) read every `kind: '<word>'` literal in
 * apps/api/src as a push kind the API sends, and a URL parameter is not one.
 */
const URL_WORD_ORDER = 'order';

/** Production fixtures (every human-readable field carries `mark`) and the attackers' accounts, written by the suite's owner client. */
export async function seedWorld(owner: PrismaClient): Promise<World> {
  const run = randomBytes(5).toString('hex');
  const mark = `VICTIM${run.toUpperCase()}`;
  const review = `matrix-review-${run}`;
  const tenantB = `matrix-b-${run}`;
  let n = 0;
  const user = (tenantId: string, roles: UserRole[], label: string, extra: Record<string, unknown> = {}) => owner.user.create({
    data: {
      phone: phone(run, ++n), firstName: label, lastName: tenantId === PRODUCTION_TENANT ? mark : 'Attacker',
      email: tenantId === PRODUCTION_TENANT ? `${mark.toLowerCase()}.${n}@example.invalid` : undefined,
      roles, activeRole: roles[0]!, isPhoneVerified: true, tenantId, ...extra,
    },
  });
  await owner.tenant.create({ data: { id: review, name: 'Matrix review fiction', slug: review, kind: 'REVIEW', purgeProtected: true } });
  await owner.reviewSession.create({ data: { tenantId: review, expiresAt: new Date(Date.now() + 86_400_000) } });
  await owner.tenant.create({ data: { id: tenantB, name: 'Matrix tenant B', slug: tenantB, isActive: true } });

  // ── the production tenant's real objects ───────────────────────────────
  const customer = await user(PRODUCTION_TENANT, ['CUSTOMER'], `${mark} Customer`, { customer: { create: {} } });
  const ownerUser = await user(PRODUCTION_TENANT, ['VENDOR_OWNER', 'CUSTOMER'], `${mark} Owner`);
  const staffUser = await user(PRODUCTION_TENANT, ['CUSTOMER'], `${mark} Staff`); // staff = a CUSTOMER account + a VendorStaff row
  const riderUser = await user(PRODUCTION_TENANT, ['MOVER', 'RIDER', 'CUSTOMER'], `${mark} Rider`);
  const driverUser = await user(PRODUCTION_TENANT, ['MOVER', 'DRIVER', 'CUSTOMER'], `${mark} Driver`);
  const vendorOwner = await owner.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await owner.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: `${mark} Store`, slug: `matrix-${run}`, vendorType: 'RESTAURANT', phone: phone(run, 90),
      addressLine1: `${mark} Lane`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.80, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  await owner.vendorStaff.create({ data: { vendorId: vendor.id, userId: staffUser.id, invitedBy: ownerUser.id, role: 'STAFF' } });
  const category = await owner.category.create({ data: { vendorId: vendor.id, name: `${mark} Menu` } });
  const item = await owner.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: `${mark} Pepperpot`, description: `${mark} secret recipe`, basePrice: 1500 } });
  const rider = await owner.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  const driver = await owner.driver.create({ data: {
    userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver', licensePlate: `M ${run.slice(0, 4)}`,
    driverLicenseUrl: 'storage://matrix/licence', vehicleInsuranceUrl: 'storage://matrix/insurance',
  } });
  const address = await owner.address.create({ data: { userId: customer.id, label: `${mark} Home`, addressLine1: `${mark} Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16 } });
  const base = {
    customerId: customer.id, deliveryAddress: `${mark} Street`, deliveryLat: 6.81, deliveryLng: -58.16, specialInstructions: undefined,
    deliveryInstructions: `${mark} ring twice`, subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 500, totalAmount: 2000, paymentMethod: 'CASH' as const,
  };
  let o = 0;
  const order = (data: Record<string, unknown>) => owner.order.create({ data: { ...base, orderNumber: `MX-${run}-${++o}`, ...data } as never });
  const live = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendorId: vendor.id, status: 'RIDER_ASSIGNED', riderId: rider.id, pickupAddress: `${mark} Lane`, pickupLat: 6.80, pickupLng: -58.15, ridePin: '135790', pickupCode: '246802' });
  const delivered = await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', vendorId: vendor.id, status: 'DELIVERED', riderId: rider.id, deliveredAt: new Date() });
  const taxi = await order({ orderType: 'TAXI', fulfillment: 'DELIVERY', status: 'DRIVER_ASSIGNED', driverId: driver.id, taxiFareTotal: 2000, pickupAddress: `${mark} Taxi Stand`, pickupLat: 6.80, pickupLng: -58.15, ridePin: '135791' });
  const courier = await order({ orderType: 'COURIER', fulfillment: 'DELIVERY', status: 'READY_FOR_PICKUP', courierRecipientName: `${mark} Recipient`, courierRecipientPhone: phone(run, 91), courierPackageDescription: `${mark} parcel`, pickupAddress: `${mark} Depot`, pickupLat: 6.80, pickupLng: -58.15 });
  const orderItem = await owner.orderItem.create({ data: { orderId: live.id, itemId: item.id, name: `${mark} Pepperpot`, quantity: 1, basePrice: 1500, markedUpPrice: 1500, markupAmount: 0, totalBase: 1500, totalMarkup: 0, totalCustomer: 1500 } });
  await owner.orderStatusLog.create({ data: { orderId: live.id, status: 'RIDER_ASSIGNED', note: `${mark} assigned` } });
  const rating = await owner.rating.create({ data: { orderId: delivered.id, raterId: customer.id, type: 'CUSTOMER_TO_VENDOR', score: 5, comment: `${mark} lovely` } as never });
  const ticket = await owner.supportTicket.create({ data: { userId: customer.id, category: 'ORDER_ISSUE', subject: `${mark} missing item`, message: `${mark} my soup was missing` } as never });
  const sos = await owner.sosAlert.create({ data: { actorUserId: customer.id, actorRole: 'CUSTOMER', orderId: taxi.id, status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date(), triggerNote: `${mark} help`, triggerAddressText: `${mark} Street` } as never });
  const room = await owner.chatRoom.create({ data: { orderId: live.id, participants: { create: [{ userId: customer.id, role: 'CUSTOMER' }, { userId: riderUser.id, role: 'RIDER' }] }, messages: { create: [{ senderId: customer.id, message: `${mark} gate code 4321` }] } } });
  const document = await owner.verificationDocument.create({ data: { userId: riderUser.id, role: 'MOVER', docType: 'drivers_licence', fileUrl: `storage://matrix/${mark}`, status: 'PENDING' } as never });
  const optionGroup = await owner.optionGroup.create({ data: { itemId: item.id, name: `${mark} Spice`, options: { create: [{ name: `${mark} Hot`, additionalPrice: 100 }] } }, include: { options: true } });
  const cart = await owner.cart.create({ data: { customerId: customer.id, vendorId: vendor.id, items: { create: [{ itemId: item.id, quantity: 2, selectedOptions: [], specialInstructions: `${mark} no onions` }] } }, include: { items: true } });
  const booking = await owner.booking.create({ data: { itemId: item.id, customerId: customer.id, slotStart: new Date(Date.now() + 86_400_000), slotEnd: new Date(Date.now() + 90_000_000) } });
  const subscription = await owner.subscription.create({ data: {
    vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2000, currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
  } });
  const claim = await owner.reimbursementClaim.create({ data: { orderId: delivered.id, riderId: rider.id, customerId: customer.id, amount: 500, reason: `${mark} spilled soup`, gpsLat: 6.81, gpsLng: -58.16 } });

  // ── the attackers: the review fiction and a second tenant ──────────────
  const reviewCustomer = await user(review, ['CUSTOMER'], 'Review Customer', { customer: { create: {} }, isSynthetic: true });
  const reviewRider = await user(review, ['MOVER', 'RIDER', 'CUSTOMER'], 'Review Rider', { isSynthetic: true });
  await owner.rider.create({ data: { userId: reviewRider.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }); // Rider has no tenantId: its user's tenant walls it
  const reviewDriver = await user(review, ['MOVER', 'DRIVER', 'CUSTOMER'], 'Review Driver', { isSynthetic: true });
  await owner.driver.create({ data: {
    userId: reviewDriver.id, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2018, vehicleColor: 'Blue', licensePlate: `R ${run.slice(0, 4)}`,
    driverLicenseUrl: 'storage://matrix/r-licence', vehicleInsuranceUrl: 'storage://matrix/r-insurance',
  } });
  const bOwner = await user(tenantB, ['VENDOR_OWNER', 'CUSTOMER'], 'TenantB Owner');
  const bVendorOwner = await owner.vendorOwner.create({ data: { userId: bOwner.id } });
  await owner.vendor.create({ data: {
    ownerId: bVendorOwner.id, name: 'Tenant B Store', slug: `matrix-b-${run}`, vendorType: 'RESTAURANT', phone: phone(run, 92), tenantId: tenantB,
    addressLine1: 'B Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.80, longitude: -58.15, status: 'ACTIVE',
  } as never });
  // A tenant ADMIN, not SUPER_ADMIN: a SUPER_ADMIN is the PLATFORM responder, unscoped on purpose for SOS
  // (TA-S0-004, safety.routes.ts isPlatformResponder), so it is no cross-tenant attacker.
  const bAdmin = await user(tenantB, ['ADMIN'], 'TenantB Admin', { admin: { create: { permissions: ['*'] } } });
  // Tenant B's SECOND administrator: approves the first one's two-person asks, so the gated handlers run.
  const bApprover = await user(tenantB, ['ADMIN'], 'TenantB Approver', { admin: { create: { permissions: ['*'] } } });

  const victimUsers = [customer.id, ownerUser.id, staffUser.id, riderUser.id, driverUser.id];
  const attackerUsers = [reviewCustomer.id, reviewRider.id, reviewDriver.id, bOwner.id, bAdmin.id, bApprover.id];
  return {
    run, mark, review, tenantB,
    victim: {
      customer: customer.id, owner: ownerUser.id, riderUser: riderUser.id, driverUser: driverUser.id, rider: rider.id, driver: driver.id,
      vendor: vendor.id, vendorOwner: vendorOwner.id, category: category.id, item: item.id, address: address.id, order: live.id,
      delivered: delivered.id, taxi: taxi.id, courier: courier.id, orderItem: orderItem.id, rating: rating.id, ticket: ticket.id,
      sos: sos.id, room: room.id, document: document.id, staffUser: staffUser.id,
      optionGroup: optionGroup.id, option: optionGroup.options[0]!.id, cart: cart.id, cartItem: cart.items[0]!.id, booking: booking.id,
      subscription: subscription.id, claim: claim.id,
    },
    attackers: [
      { label: 'review customer', userId: reviewCustomer.id, role: 'CUSTOMER' },
      { label: 'review rider', userId: reviewRider.id, role: 'RIDER' },
      { label: 'review driver', userId: reviewDriver.id, role: 'DRIVER' },
      { label: 'tenant-B store owner', userId: bOwner.id, role: 'VENDOR_OWNER' },
      { label: 'tenant-B admin', userId: bAdmin.id, role: 'ADMIN' },
    ],
    approvers: { [bAdmin.id]: { userId: bApprover.id, role: 'ADMIN' } },
    cleanup: async () => {
      const all = [...victimUsers, ...attackerUsers];
      const swallow = () => undefined;
      await owner.session.deleteMany({ where: { userId: { in: all } } }).catch(swallow);
      await owner.reimbursementClaim.deleteMany({ where: { customerId: { in: all } } }).catch(swallow);
      await owner.booking.deleteMany({ where: { customerId: { in: all } } }).catch(swallow);
      await owner.cart.deleteMany({ where: { customerId: { in: all } } }).catch(swallow);
      // Ratings (SetNull on the order) and the chat room's participants and messages hold the
      // users: without these the user delete below failed as ONE statement and stranded every
      // attacker, both fiction tenants and the victims (tenancy-foundation counts them).
      await owner.rating.deleteMany({ where: { raterId: { in: all } } }).catch(swallow);
      await owner.chatMessage.deleteMany({ where: { OR: [{ chatRoomId: room.id }, { senderId: { in: all } }] } }).catch(swallow);
      await owner.chatRoomParticipant.deleteMany({ where: { OR: [{ chatRoomId: room.id }, { userId: { in: all } }] } }).catch(swallow);
      await owner.chatRoom.deleteMany({ where: { id: room.id } }).catch(swallow);
      await owner.subscription.deleteMany({ where: { vendor: { ownerId: { in: [vendorOwner.id, bVendorOwner.id] } } } }).catch(swallow);
      await owner.order.deleteMany({ where: { OR: [{ customerId: { in: all } }, { vendor: { ownerId: { in: [vendorOwner.id, bVendorOwner.id] } } }] } }).catch(swallow);
      await owner.verificationDocument.deleteMany({ where: { userId: { in: all } } }).catch(swallow);
      await owner.sosAlert.deleteMany({ where: { actorUserId: { in: all } } }).catch(swallow);
      await owner.supportTicket.deleteMany({ where: { userId: { in: all } } }).catch(swallow);
      await owner.address.deleteMany({ where: { userId: { in: all } } }).catch(swallow);
      await owner.vendor.deleteMany({ where: { ownerId: { in: [vendorOwner.id, bVendorOwner.id] } } }).catch(swallow);
      await owner.vendorOwner.deleteMany({ where: { id: { in: [vendorOwner.id, bVendorOwner.id] } } }).catch(swallow);
      await owner.rider.deleteMany({ where: { userId: { in: all } } }).catch(swallow);
      await owner.driver.deleteMany({ where: { userId: { in: all } } }).catch(swallow);
      // The last three are not swallowed: a row left behind here outlives the suite and breaks
      // whole-database checks in later files, so a failure must surface in THIS suite.
      await owner.user.deleteMany({ where: { id: { in: all } } });
      await owner.reviewSession.deleteMany({ where: { tenantId: review } }).catch(swallow);
      await owner.tenant.updateMany({ where: { id: review }, data: { purgeProtected: false } });
      const tenants = await owner.tenant.deleteMany({ where: { id: { in: [review, tenantB] } } });
      if (tenants.count !== 2) throw new Error(`matrix cleanup left ${2 - tenants.count} fiction tenant(s) behind`);
    },
  };
}

/** A live session and access token for an attacker (privileged roles sign in by OTP, as their assurance requires). */
export async function mintToken(app: FastifyInstance, owner: PrismaClient, attacker: { userId: string; role: UserRole }): Promise<string> {
  const token = app.jwt.sign({ userId: attacker.userId, role: attacker.role, jti: randomBytes(6).toString('hex') });
  // This raw owner client sits outside the app client's credential-digest
  // extension, so it stores the digests itself (sessions keep digests only).
  await owner.session.create({ data: {
    userId: attacker.userId, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(randomBytes(24).toString('hex')), authMethod: 'OTP',
    deviceId: 'matrix', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
  } });
  return token;
}

/** Path params: the production object each segment names. */
export function materialize(url: string, w: World): string {
  const v = w.victim;
  const bySegment: Record<string, string> = {
    orders: v.order, order: v.order, deliveries: v.order, jobs: v.order, legs: v.order, offers: v.order, receipts: v.delivered,
    rides: v.taxi, ride: v.taxi, trips: v.taxi, courier: v.courier, parcels: v.courier,
    vendors: v.vendor, vendor: v.vendor, stores: v.vendor, store: v.vendor,
    items: v.item, item: v.item, products: v.item, listings: v.item, categories: v.category,
    users: v.customer, customers: v.customer, accounts: v.customer, partners: v.owner,
    riders: v.rider, drivers: v.driver, movers: v.riderUser,
    addresses: v.address, ratings: v.rating, reviews: v.rating, tickets: v.ticket, support: v.ticket,
    alerts: v.sos, sos: v.sos, rooms: v.room, chat: v.room, documents: v.document, docs: v.document, submissions: v.document,
    staff: v.staffUser, lines: v.orderItem,
    'option-groups': v.optionGroup, options: v.option, bookings: v.booking, subscriptions: v.subscription, claims: v.claim,
  };
  const byName: Record<string, string> = {
    userId: v.customer, vendorId: v.vendor, itemId: v.item, roomId: v.room, caseId: v.sos, docId: v.document, lineId: v.orderItem,
    subscriptionId: v.subscription, sessionId: v.order, cardId: v.order, groupId: v.optionGroup, blockedUserId: v.customer,
    slug: `matrix-${w.run}`, code: 'MATRIX', token: 'matrix-token', key: 'matrix-key', ref: 'MATRIXREF', san: '000000000', format: 'json',
    kind: URL_WORD_ORDER, action: 'view', queue: URL_WORD_ORDER,
  };
  const parts = url.split('/');
  return parts.map((part, i) => {
    if (!part.startsWith(':')) return part;
    const name = part.slice(1);
    if (name !== 'id') return byName[name] ?? v.order;
    const segment = (parts[i - 1] ?? '').toLowerCase();
    if (segment === 'items' && parts[i - 2] === 'cart') return v.cartItem; // /cart/items/:id is a cart line, not a menu item
    return bySegment[segment] ?? v.order;
  }).join('/');
}

/** Query and body fields naming production objects (a route that trusts a field for authority is attacked through it). */
export function poison(w: World): { query: string; body: Record<string, unknown> } {
  const v = w.victim;
  const ids = {
    orderId: v.order, vendorId: v.vendor, storeId: v.vendor, itemId: v.item, userId: v.customer, customerId: v.customer,
    riderId: v.rider, driverId: v.driver, addressId: v.address, ratingId: v.rating, ticketId: v.ticket, roomId: v.room,
    chatRoomId: v.room, documentId: v.document, sosAlertId: v.sos, alertId: v.sos, categoryId: v.category, staffUserId: v.staffUser,
    optionGroupId: v.optionGroup, optionId: v.option, cartId: v.cart, cartItemId: v.cartItem, bookingId: v.booking, subscriptionId: v.subscription,
    claimId: v.claim,
  };
  return {
    query: new URLSearchParams({ orderId: v.order, vendorId: v.vendor, userId: v.customer, customerId: v.customer, q: w.mark }).toString(),
    body: { ...ids, id: v.order, ids: [v.order], quantity: 1, items: [{ itemId: v.item, quantity: 1 }], reason: 'matrix probe', note: 'matrix probe', message: 'matrix probe', comment: 'matrix probe', status: 'CANCELLED', score: 1 },
  };
}

/**
 * [REVIEW-M #2126 S4-1] VALID bodies for the two-person money and platform routes whose handler refuses the generic
 * poison body at validation (it would never reach the object lookup). Each still names the production object where the
 * schema takes one; the path ids come from materialize. The six admin billing mutations are fail-closed for every tenant
 * but the production one (TENANT_BILLING_UNAVAILABLE, before any lookup: receipt counters are not tenant-aware), so no
 * second-tenant fixture can open them; their bodies are valid too, so the day that guard opens they reach the lookup.
 */
export function craftedBodies(w: World): Record<string, Record<string, unknown>> {
  const v = w.victim;
  const A = '/api/v1/admin';
  const at = new Date(Date.UTC(2026, 0, 15, 12)).toISOString();
  const sunsetAt = new Date(Date.now() + 60 * 86_400_000).toISOString();
  return {
    [`POST ${A}/orders/:id/close-store-refund`]: { expectedClaimRevision: 0, reason: 'matrix probe' },
    [`PUT ${A}/orders/:id/refund-settled`]: { reference: 'MATRIX-REF', amount: 100 },
    [`POST ${A}/billing/mover-fees/:userId/resolve`]: { expectedRevision: 1, canonicalSubscriptionId: v.subscription, sourceSubscriptionIds: [v.subscription], reason: 'matrix probe' },
    [`POST ${A}/notifications/broadcast`]: { title: 'matrix probe', body: 'matrix probe', category: 'service' },
    [`POST ${A}/ads/refund-intents/:id/settle`]: { manualPayoutRef: 'MATRIX-REF' },
    [`PUT ${A}/ads/invoices/:id/mark-paid`]: { reference: 'MATRIX-REF' },
    [`POST ${A}/billing/usd-migration/mode-b`]: { sunsetAt },
    [`POST ${A}/billing/confirmations/:id/resolve`]: { sourceId: v.subscription, epoch: 1, clockVersion: 0, decision: 'UNPAID', evidenceReference: 'MATRIX evidence 0001', reason: 'matrix probe' },
    [`POST ${A}/billing/mmg-checkouts/:id/reverse`]: { amountGyd: 2000, reason: 'matrix probe' },
    [`POST ${A}/billing/mmg-fee-reversals/:id/resolve`]: { outcome: 'NOT_RETURNED', mmgReference: 'MATRIX-REF', reason: 'matrix probe' },
    [`POST ${A}/billing/settlement-batches/:id/confirm-deposit`]: { depositedGyd: 2000, depositedAt: at, bankRef: 'MATRIX-REF' },
    [`POST ${A}/billing/settlement-batches/:id/adjust-deposit`]: { depositedGyd: 2000, depositedAt: at, bankRef: 'MATRIX-REF', reason: 'matrix probe' },
    [`PUT ${A}/returns/:id/resolve`]: { status: 'APPROVED', note: 'matrix probe' },
    [`PUT ${A}/returns/:id/refund-settled`]: { reference: 'MATRIX-REF', amount: 100, note: 'matrix probe' },
    [`PUT ${A}/cash-rules/claims/:id/paid`]: { reference: 'MATRIX-REF', amount: 500 },
    // fail-closed for tenant B today (TENANT_BILLING_UNAVAILABLE): valid, so they reach the lookup if that ever opens
    [`POST ${A}/subscriptions/:id/topup`]: { amount: 2000, reference: 'MATRIX-REF' },
    [`POST ${A}/subscriptions/:id/refund-credit/set-aside`]: { amount: 100 },
    [`POST ${A}/subscriptions/:id/refund-credit/release`]: { amount: 100, setAsideId: v.subscription },
    [`POST ${A}/billing/agent-payments`]: { san: '000000000', amount: 2000, paidAt: at, receiptNumber: 'MATRIX-001', verifiedInPortal: true },
    [`POST ${A}/billing/agent-payments/:id/attach`]: { subscriptionId: v.subscription },
    [`POST ${A}/billing/settlement-import`]: { csv: 'date,reference,amount\n2026-01-15,MATRIX-REF,2000', source: 'matrix probe' },
  };
}

/** Headers a crafted route needs to reach its lookup: the recorded fee payment demands its Idempotency-Key first. */
export function craftedHeaders(w: World): Record<string, Record<string, string>> {
  return { 'POST /api/v1/admin/subscriptions/:id/topup': { 'idempotency-key': `matrix-topup-${w.run}` } };
}

/**
 * Routes the matrix never fires: identity/session routes (covered by the auth suites; logout would end the
 * attacker's own session), provider webhooks, and the attacker's OWN account deletion (it acts on the caller
 * only, and every later request would answer 401: a vacuous pass).
 */
export function skipped(method: string, url: string): boolean {
  return url.startsWith('/api/v1/auth/') || /\/webhooks?\b/.test(url) || /\/logout\b/.test(url)
    || (method === 'DELETE' && /\/account$/.test(url)) || /\/account\/(delete|deactivate)\b/.test(url);
}

export interface Finding { attacker: string; method: string; url: string; status: number; why: string }
/** The approval leg's tally: asks (202 with an approval id), asks the colleague APPROVED, re-sends, re-sends the gate
 *  let through to the handler (the approval is spent: APPLIED), and the re-sends' statuses. */
export interface ApprovalLeg { asked: number; approved: number; resent: number; reached: number; byStatus: Record<string, number>; byRoute: Record<string, string> }

/** The error code an answer names ('' for none): what stopped a handler (validation, a refused object, billing). */
function errorCodeOf(body: string): string {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : '';
  } catch {
    return '';
  }
}

/** The approval id a 202 APPROVAL_REQUIRED answer names, or null. */
function approvalIdOf(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { error?: { details?: { approvalId?: unknown } } })?.error?.details?.approvalId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Fire every route at the production objects as every attacker. */
export async function sweep(
  app: FastifyInstance,
  owner: PrismaClient,
  w: World,
  routes: Array<{ method: string; url: string }>,
  attacker: World['attackers'][number],
): Promise<{ findings: Finding[]; fired: number; byStatus: Record<string, number>; firstRefused: string | null; unanswered: string[]; approvals: ApprovalLeg }> {
  let token = await mintToken(app, owner, attacker);
  // Positive control: the attacker really is signed in, as itself. A refused token would turn
  // every authenticated route into a 401 and the whole sweep into a vacuous pass.
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  if (me.statusCode !== 200 || !me.body.includes(attacker.userId)) {
    throw new Error(`${attacker.label}: the attacker's own session is refused (${me.statusCode} ${me.body.slice(0, 300)})`);
  }
  const { query, body } = poison(w);
  const crafted = craftedBodies(w);
  const craftedHead = craftedHeaders(w);
  const findings: Finding[] = [];
  const byStatus: Record<string, number> = {};
  let fired = 0;
  let firstRefused: string | null = null;
  const unanswered: string[] = [];
  const approver = w.approvers[attacker.userId];
  let approverToken: string | null = null;
  const approvals: ApprovalLeg = { asked: 0, approved: 0, resent: 0, reached: 0, byStatus: {}, byRoute: {} };
  const tally = (key: string) => { approvals.byStatus[key] = (approvals.byStatus[key] ?? 0) + 1; };
  let previous = '(start)';
  const seen = new Set<string>();
  for (const { method, url } of routes) {
    if (skipped(method, url) || seen.has(`${method} ${url}`)) continue;
    seen.add(`${method} ${url}`);
    const path = materialize(url, w);
    const fire = (bearer: string, approvalId?: string) => {
      const opts: InjectOptions = {
        method: method as InjectOptions['method'],
        url: method === 'GET' || method === 'DELETE' ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path,
        headers: {
          authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-vendor-id': w.victim.vendor, 'x-swift-reason': 'matrix probe',
          ...(craftedHead[`${method} ${url}`] ?? {}),
          ...(approvalId ? { 'x-swift-approval': approvalId } : {}),
        },
      };
      if (method !== 'GET' && method !== 'DELETE') opts.payload = crafted[`${method} ${url}`] ?? body;
      return app.inject(opts);
    };
    let res = await fire(token);
    if (res.statusCode === 401) {
      // The route may have ended the attacker's own session (a sign-out, a role switch): a fresh one, once.
      token = await mintToken(app, owner, attacker);
      res = await fire(token);
    }
    fired += 1;
    if (res.statusCode === 401 && !firstRefused) firstRefused = `${method} ${url} after ${previous}: ${res.body.slice(0, 160)}`;
    previous = `${method} ${url} ${res.statusCode}`;
    byStatus[String(res.statusCode)] = (byStatus[String(res.statusCode)] ?? 0) + 1;
    if (res.statusCode === 429 || res.statusCode >= 500) unanswered.push(`${res.statusCode} ${method} ${url}`);
    if (res.statusCode >= 200 && res.statusCode < 300 && res.body.includes(w.mark)) {
      findings.push({ attacker: attacker.label, method, url, status: res.statusCode, why: 'a 2xx answer carries production data' });
    }
    // [REVIEW-M #2069 S3-1 · the approval leg] A two-person route answered 202 before its handler ran: the
    // attacker's same-tenant colleague approves, and the attacker re-sends the exact request with the approval
    // (the gate's own path: fingerprint and reason checked again), so the HANDLER now meets the production objects.
    const approvalId = res.statusCode === 202 && approver ? approvalIdOf(res.body) : null;
    if (res.statusCode === 202 && approver && !approvalId) tally('202 without an approval id');
    if (approvalId && approver) {
      approvals.asked += 1;
      approverToken ??= await mintToken(app, owner, approver);
      const decide = await app.inject({
        method: 'POST', url: `/api/v1/admin/approvals/${approvalId}/decide`,
        headers: { authorization: `Bearer ${approverToken}`, 'content-type': 'application/json', 'x-swift-reason': 'matrix probe' },
        payload: { approve: true, note: 'matrix approval leg' },
      });
      const decided = decide.statusCode === 200 ? (JSON.parse(decide.body) as { data?: { status?: string } }).data?.status : undefined;
      if (decided !== 'APPROVED') tally(`decide ${decide.statusCode} ${decided ?? ''}`.trim());
      else {
        approvals.approved += 1;
        let again = await fire(token, approvalId);
        if (again.statusCode === 401) { token = await mintToken(app, owner, attacker); again = await fire(token, approvalId); }
        approvals.resent += 1;
        tally(String(again.statusCode));
        approvals.byRoute[`${method} ${url}`] = `${again.statusCode} ${errorCodeOf(again.body)}`.trim();
        // The gate spends an approval only when it lets the request through to the handler.
        const spent = await owner.privilegedApproval.findUnique({ where: { id: approvalId }, select: { status: true } });
        if (spent?.status === 'APPLIED') approvals.reached += 1;
        else tally(`not let through (${spent?.status ?? 'gone'})`);
        if (again.statusCode === 429 || again.statusCode >= 500) unanswered.push(`approved ${again.statusCode} ${method} ${url}`);
        if (again.statusCode >= 200 && again.statusCode < 300 && again.body.includes(w.mark)) {
          findings.push({ attacker: attacker.label, method, url, status: again.statusCode, why: 'an approved two-person ask, re-sent, carries production data' });
        }
      }
    }
  }
  return { findings, fired, byStatus, firstRefused, unanswered, approvals };
}

/** Every production fixture row, as it stands. */
export async function digestProduction(owner: PrismaClient, w: World): Promise<Record<string, string>> {
  const v = w.victim;
  const rows: Record<string, unknown> = {
    users: await owner.user.findMany({ where: { id: { in: [v.customer, v.owner, v.staffUser, v.riderUser, v.driverUser] } }, orderBy: { id: 'asc' } }),
    vendor: await owner.vendor.findUnique({ where: { id: v.vendor } }),
    staff: await owner.vendorStaff.findMany({ where: { vendorId: v.vendor }, orderBy: { id: 'asc' } }),
    category: await owner.category.findUnique({ where: { id: v.category } }),
    items: await owner.item.findMany({ where: { vendorId: v.vendor }, orderBy: { id: 'asc' } }),
    rider: await owner.rider.findUnique({ where: { id: v.rider } }),
    driver: await owner.driver.findUnique({ where: { id: v.driver } }),
    addresses: await owner.address.findMany({ where: { userId: v.customer }, orderBy: { id: 'asc' } }),
    orders: await owner.order.findMany({ where: { id: { in: [v.order, v.delivered, v.taxi, v.courier] } }, orderBy: { id: 'asc' } }),
    orderItems: await owner.orderItem.findMany({ where: { orderId: v.order }, orderBy: { id: 'asc' } }),
    logs: await owner.orderStatusLog.findMany({ where: { orderId: { in: [v.order, v.delivered, v.taxi, v.courier] } }, orderBy: { id: 'asc' } }),
    ratings: await owner.rating.findMany({ where: { orderId: v.delivered }, orderBy: { id: 'asc' } }),
    tickets: await owner.supportTicket.findMany({ where: { userId: v.customer }, orderBy: { id: 'asc' } }),
    sos: await owner.sosAlert.findMany({ where: { actorUserId: v.customer }, orderBy: { id: 'asc' } }),
    chat: await owner.chatRoom.findUnique({ where: { id: v.room }, include: { participants: { orderBy: { id: 'asc' } }, messages: { orderBy: { id: 'asc' } } } }),
    documents: await owner.verificationDocument.findMany({ where: { userId: v.riderUser }, orderBy: { id: 'asc' } }),
    carts: await owner.cart.findMany({ where: { customerId: v.customer }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    optionGroups: await owner.optionGroup.findMany({ where: { itemId: v.item }, include: { options: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    bookings: await owner.booking.findMany({ where: { customerId: v.customer }, orderBy: { id: 'asc' } }),
    subscription: await owner.subscription.findUnique({ where: { id: v.subscription } }),
    // [REVIEW-M #2126 S4-1] what a money handler would write beside the plan, and what a broadcast would put in a production inbox
    prepaid: await owner.prepaidBalance.findMany({ where: { subscriptionId: v.subscription }, orderBy: { id: 'asc' } }),
    payments: await owner.subscriptionPayment.findMany({ where: { subscriptionId: v.subscription }, orderBy: { id: 'asc' } }),
    billingEvents: await owner.billingEvent.findMany({ where: { subscriptionId: v.subscription }, orderBy: { id: 'asc' } }),
    inbox: await owner.notification.findMany({ where: { userId: { in: [v.customer, v.owner, v.staffUser, v.riderUser, v.driverUser] } }, orderBy: { id: 'asc' } }),
    claims: await owner.reimbursementClaim.findMany({ where: { customerId: v.customer }, orderBy: { id: 'asc' } }),
  };
  return Object.fromEntries(Object.entries(rows).map(([k, value]) => [k, createHash('sha256').update(JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? String(val) : val))).digest('hex')]));
}
