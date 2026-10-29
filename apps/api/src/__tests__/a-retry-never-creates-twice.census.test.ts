import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ADMIN_ROUTE_AUTHORITY, ADMIN_ACTION_CLASSES, type AdminRouteKey } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C2 · server] A retried request never creates an order, a
// parcel, a ride, a payment claim, a refund, a payout, a fee checkout or ad
// spend twice.
//
// Phones retry: a lost answer, a double tap, a flaky network. A route that
// creates one of those things must make the second request a no-op, by:
//   key       an Idempotency-Key (withIdempotency, or the route's own receipt
//             key) — optional, so a request without one still succeeds (store
//             builds 9 and 11 send none on most routes);
//   unique    a DB unique constraint that makes the replay a no-op;
//   state     a compare-and-set / locked state check, so the replay finds the
//             work done and changes nothing;
//   approval  an admin money route (class C4/C5): every execution spends its
//             own second-admin approval, APPROVED -> APPLIED by compare-and-
//             set at the gate before the handler runs, so a replay of the
//             executing request is refused 'already-applied';
//   refused   the route refuses every request today (nothing to create).
// Every guard is PINNED: the census reads the handler or the named function
// and requires the exact code that does the guarding, so removing it fails.
// New routes cannot slip past: every POST/PUT/PATCH route whose last path
// segment is a create/money verb, or a money-bearing state transition
// (delivered / complete / handover / collect / cancel / quote / accept), must
// be classified here (in SCOPE, or in OUT with the reason it creates none of
// those); an admin route of class C4/C5 is covered by the approval gate
// automatically. Every registration must sit in a *.routes.ts file with a
// literal path, or the census could not read it.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');

type Kind = 'order' | 'parcel' | 'ride' | 'payment-claim' | 'refund' | 'payout' | 'fee-checkout' | 'ad-spend';
type Guard = 'key' | 'unique' | 'state' | 'approval' | 'refused';
/** [file under src, function name ('' = the route handler itself), code that must be there]. */
type Pin = [string, string, string];
interface Entry { kind: Kind; guard: Guard; pins: Pin[] }
interface Route { file: string; method: string; path: string; handler: string }
/** [#1964 review F2 S4-2] A registration the census cannot read: outside *.routes.ts, or a non-literal path. */
const REGISTER = /^(post|put|patch)$/;

/** Create/money verbs, plus [#1964 review F2 S3-1 / G S4-1] the transitions that mint money rows inside a
 *  state change (earnings + cash settlement on delivered/complete, cash CAPTURED at handover/collect, a refund
 *  obligation on cancel) and the noun creators the review named (accept, house, fx-rates); [#1964 delta review
 *  F2 S4-3] the compound terminals complete-pickup (cash takeaway CAPTURED, OF-05) and complete-appointment. */
const VERB = /^(checkout|order|orders|request|payment-claim|refund[a-z-]*|topup|payout|paid|settle|confirm-payment|confirm-deposit|adjust[a-z-]*|reverse|card-sessions|mmg-checkout|reserve|campaigns|agent-payments|attach|tip|return|process|mark-paid|set-aside|release|settlement-import|backfill|notify|resolve|confirm|refund-settled|close-store-refund|jobs|delivered|complete|handover|collect|cancel|quote|accept|house|fx-rates|complete-pickup|complete-appointment)$/;

/** Every route registration in a *.routes.ts file: app.post('/path', …, handler). */
function routesOf(files: Record<string, string>, unreadable: string[] = []): Route[] {
  const out: Route[] = [];
  for (const [file, text] of Object.entries(files)) {
    const routesFile = /\.routes\.ts$/.test(file);
    if (!routesFile && !/\.(post|put|patch)(<[^>]*>)?\(\s*['"`/]/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(post|put|patch|delete)$/.test(n.expression.name.text)) {
        const a0 = n.arguments[0];
        const literal = !!a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) && a0.text.startsWith('/');
        const method = n.expression.name.text;
        if (routesFile && literal) {
          out.push({ file, method: method.toUpperCase(), path: (a0 as ts.StringLiteral).text, handler: n.arguments[n.arguments.length - 1]!.getText() });
        } else if (REGISTER.test(method) && n.arguments.length >= 2 && a0 && (literal || routesFile)) {
          unreadable.push(`${file}|${method.toUpperCase()}|${a0.getText()}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The body text of a named function / method / const arrow in a file. */
function functionText(files: Record<string, string>, file: string, name: string): string | null {
  const text = files[file];
  if (text === undefined) return null;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found !== null) return;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name?.getText() === name && n.body) found = n.body.getText();
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer.body.getText();
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const idOf = (r: Route) => `${r.file}|${r.method}|${r.path}`;
const lastSegment = (path: string) => path.split('/').filter(Boolean).pop() ?? '';
const isAdmin = (r: Route) => r.file === 'modules/admin/admin.routes.ts';
const approvalClass = (r: Route) => {
  const a = ADMIN_ROUTE_AUTHORITY[`${r.method} ${r.path}` as AdminRouteKey];
  return a && ADMIN_ACTION_CLASSES[a.cls].requiresApproval ? a.cls : null;
};

interface Census { routes: number; inScope: string[]; byApproval: string[]; unclassified: string[]; missingRoutes: string[]; brokenPins: string[]; unreadable: string[] }

function census(files: Record<string, string>, scope: Record<string, Entry>, out: Record<string, string>, pendingFix: Record<string, string>, gatePins: Pin[]): Census {
  const unreadable: string[] = [];
  const routes = routesOf(files, unreadable);
  const ids = new Set(routes.map(idOf));
  const result: Census = { routes: routes.length, inScope: [], byApproval: [], unclassified: [], missingRoutes: [], brokenPins: [], unreadable };
  const pinHolds = ([file, fn, code]: Pin, handler?: string): boolean => {
    const text = fn === '' ? handler : functionText(files, file, fn);
    return text != null && text.includes(code);
  };
  for (const r of routes) {
    if (r.method === 'DELETE' || !VERB.test(lastSegment(r.path))) continue;
    const id = idOf(r);
    if (scope[id] || out[id] || pendingFix[id]) continue;
    if (isAdmin(r) && approvalClass(r)) { result.byApproval.push(id); continue; }
    result.unclassified.push(id);
  }
  for (const [id, entry] of Object.entries(scope)) {
    const route = routes.find((r) => idOf(r) === id);
    if (!route) { result.missingRoutes.push(id); continue; }
    result.inScope.push(id);
    if (entry.guard === 'approval' && !approvalClass(route)) result.brokenPins.push(`${id}: listed as approval-gated, but its admin class does not require a second admin`);
    for (const pin of entry.pins) {
      const handlerFile = pin[0] === route.file && pin[1] === '';
      if (!pinHolds(pin, handlerFile ? route.handler : undefined)) result.brokenPins.push(`${id}: ${pin[1] || 'the handler'} in ${pin[0]} no longer contains \`${pin[2]}\``);
    }
  }
  for (const id of [...Object.keys(out), ...Object.keys(pendingFix)]) if (!ids.has(id)) result.missingRoutes.push(id);
  for (const pin of gatePins) if (!pinHolds(pin)) result.brokenPins.push(`approval gate: ${pin[1]} in ${pin[0]} no longer contains \`${pin[2]}\``);
  return result;
}

const H = '';
const CUSTOMER = 'modules/user/customer.routes.ts';
const ADMIN = 'modules/admin/admin.routes.ts';
const VENDOR = 'modules/vendor/vendor.routes.ts';
const ORDER_SVC = 'modules/order/order.service.ts';
const SERVICES_SVC = 'modules/services/services.service.ts';
const approval = (kind: Kind): Entry => ({ kind, guard: 'approval', pins: [] });
const MMG_REPLY_CAS: Pin[] = [['modules/billing/mmg-checkout.service.ts', 'observeReply', 'where: { id: current.id, status: current.status },'], ['modules/billing/mmg-checkout.service.ts', 'observeReply', 'if (moved.count !== 1)']];
/** Every order transition runs here: the order row locked FOR UPDATE, then the source status checked
 *  against the caller's allowedFrom, so a replay finds the order already moved and changes nothing. */
const ORDER_CAS: Pin[] = [[ORDER_SVC, 'stageCanonicalOrderTransition', 'FOR UPDATE'], [ORDER_SVC, 'stageCanonicalOrderTransition', 'if (!input.allowedFrom.includes(source.status))']];
/** A money-bearing order transition: its own allowedFrom in the handler, and the shared compare-and-set. */
const transition = (kind: Kind, file: string, allowedFrom: string, more: Pin[] = []): Entry => ({ kind, guard: 'state', pins: [[file, H, allowedFrom], ...ORDER_CAS, ...more] });
/** Earnings + the cash-settlement ledger are written once, inside the DELIVERED transition (orderId is unique). */
const EARNINGS: Pin = [ORDER_SVC, 'createEarnings', 'await db.deliveryCashSettlement.upsert({'];
/** Cash CAPTURED at the door: the locked row's handover version changes with the capture, so a replay is stale. */
const HANDOVER: Pin = ['modules/cash/cash-rules.service.ts', 'handover', 'if (!handoverVersionMatches(lockedSource, input.handoverVersion))'];
/** A cancel: the order lock and the CANCELLED edge decide it (refund obligations ride the same commit). */
const CANCEL: Pin[] = [[ORDER_SVC, 'cancelOrder', 'if (!ORDER_TRANSITIONS.CANCELLED.includes(order.status))'], [ORDER_SVC, 'cancelOrder', 'lockTaxiOrderForCustodyDecision(tx, orderId)']];

/** The routes that create one of the eight things, and what makes each replay a no-op. */
const SCOPE: Record<string, Entry> = {
  // Orders, parcels, rides: a receipt key bound to the request (optional; a keyless request still places once).
  [`${CUSTOMER}|POST|/checkout`]: { kind: 'order', guard: 'key', pins: [[CUSTOMER, H, 'newCheckoutClaim(']] },
  'modules/courier/courier.routes.ts|POST|/order': { kind: 'parcel', guard: 'key', pins: [['modules/courier/courier.routes.ts', H, 'courierReceiptKey(']] },
  'modules/rides/rides.routes.ts|POST|/request': { kind: 'ride', guard: 'key', pins: [['modules/rides/rides.routes.ts', H, 'rideRequestReceiptKey(']] },
  // [#1964 review F2 S4-1 / G S4-2] State pins name the compare-and-set's where clause, not a bare updateMany(.
  [`${CUSTOMER}|POST|/orders/:id/convert-to-pickup`]: { kind: 'order', guard: 'state', pins: [[CUSTOMER, H, "fulfillment: 'DELIVERY',"], [CUSTOMER, H, 'if (converted.count === 0)']] },
  // Payment claims.
  [`${CUSTOMER}|POST|/orders/:id/payment-claim`]: { kind: 'payment-claim', guard: 'state', pins: [[CUSTOMER, H, 'outcome.replayed'], ['modules/order/mmg-claim.service.ts', 'recordCustomerMmgClaim', 'replayed']] },
  'modules/vendor/vendor.routes.ts|POST|/orders/:id/confirm-payment': { kind: 'payment-claim', guard: 'state', pins: [[VENDOR, H, "paymentStatus: { notIn: ['CAPTURED', 'CLAIMED'] },"], [VENDOR, H, 'mmgClaimRevision: locked.mmgClaimRevision,']] },
  // C3 (no second admin): the claim revision is compare-and-set under the order lock; a replay answers REPLAY.
  [`${ADMIN}|POST|/orders/:id/payment-claim/resolve`]: { kind: 'payment-claim', guard: 'state', pins: [['modules/order/mmg-claim.service.ts', 'resolveMmgClaimDisagreement', 'mmgClaimRevision: input.expectedClaimRevision'], ['modules/order/mmg-claim.service.ts', 'resolveMmgClaimDisagreement', "decision.kind === 'REPLAY'"]] },
  // Refunds.
  [`${CUSTOMER}|POST|/orders/:id/return`]: { kind: 'refund', guard: 'unique', pins: [[CUSTOMER, H, 'isDuplicateOn(']] },
  'modules/vendor/vendor.routes.ts|POST|/orders/:id/items/:lineId/refund-line': { kind: 'refund', guard: 'state', pins: [['modules/order/picking.service.ts', 'refundLine', "line.subStatus === 'REFUNDED'"]] },
  [`${ADMIN}|POST|/orders/:id/close-store-refund`]: approval('refund'),
  [`${ADMIN}|PUT|/orders/:id/refund-settled`]: approval('refund'),
  [`${ADMIN}|PUT|/returns/:id/refund-settled`]: approval('refund'),
  [`${ADMIN}|POST|/subscriptions/:id/refund-credit/set-aside`]: approval('refund'),
  [`${ADMIN}|POST|/subscriptions/:id/refund-credit/paid`]: approval('refund'),
  [`${ADMIN}|POST|/subscriptions/:id/refund-credit/release`]: approval('refund'),
  [`${ADMIN}|POST|/ads/refund-intents/:id/settle`]: approval('refund'),
  [`${ADMIN}|POST|/ads/refund-intents/backfill`]: approval('refund'),
  [`${ADMIN}|POST|/billing/agent-payments/:id/refund-flag`]: approval('refund'),
  [`${ADMIN}|POST|/billing/mmg-checkouts/:id/reverse`]: approval('refund'),
  [`${ADMIN}|POST|/billing/mmg-fee-reversals/:id/resolve`]: approval('refund'),
  // Payouts and cash settlements.
  'modules/vendor/vendor.routes.ts|POST|/cash-settlements/:id/confirm': { kind: 'payout', guard: 'state', pins: [['modules/cash/delivery-cash-settlement.service.ts', 'confirm', 'status: CashSettlementStatus.OWED']] },
  'modules/rider/rider.routes.ts|POST|/cash-settlements/:id/confirm': { kind: 'payout', guard: 'state', pins: [['modules/cash/delivery-cash-settlement.service.ts', 'confirm', 'status: CashSettlementStatus.OWED']] },
  [`${ADMIN}|PUT|/finance/settlements/:id/process`]: approval('payout'),
  [`${ADMIN}|POST|/finance/settlements/:id/adjust`]: approval('payout'),
  [`${ADMIN}|PUT|/cash-rules/claims/:id/paid`]: approval('payout'),
  [`${ADMIN}|POST|/cash-rules/rlp/reserve/adjust`]: approval('payout'),
  [`${ADMIN}|POST|/billing/settlement-batches/:id/confirm-deposit`]: approval('payout'),
  [`${ADMIN}|POST|/billing/settlement-batches/:id/adjust-deposit`]: approval('payout'),
  // Weekly-fee checkouts and fee money.
  'modules/billing/mmg-checkout.routes.ts|POST|/subscription/mmg-checkout': { kind: 'fee-checkout', guard: 'key', pins: [['modules/billing/mmg-checkout.service.ts', 'createCheckout', 'const replay = await this.answerForKey(who, now);']] },
  'modules/billing/mmg-checkout.routes.ts|POST|/notify': { kind: 'fee-checkout', guard: 'state', pins: MMG_REPLY_CAS },
  'modules/billing/mmg-checkout.routes.ts|POST|/return': { kind: 'fee-checkout', guard: 'state', pins: MMG_REPLY_CAS },
  'modules/billing/card-rail.routes.ts|POST|/subscription/card-sessions': { kind: 'fee-checkout', guard: 'key', pins: [['modules/billing/card-rail.routes.ts', H, 'subscriptionId_purpose_idempotencyKey: { subscriptionId: sub.id, purpose, idempotencyKey: key }']] },
  [`${ADMIN}|POST|/subscriptions/:id/topup`]: approval('fee-checkout'),
  [`${ADMIN}|PUT|/subscriptions/:id/waive-fee`]: approval('fee-checkout'),
  [`${ADMIN}|POST|/billing/mover-fees/:userId/resolve`]: approval('fee-checkout'),
  [`${ADMIN}|POST|/billing/agent-payments`]: approval('fee-checkout'),
  [`${ADMIN}|POST|/billing/agent-payments/:id/attach`]: approval('fee-checkout'),
  [`${ADMIN}|POST|/billing/settlement-import`]: approval('fee-checkout'),
  [`${ADMIN}|PUT|/ads/invoices/:id/mark-paid`]: approval('fee-checkout'),
  // Ad spend (ads are OFF at launch; the routes still guard).
  'modules/ads/ads.routes.ts|POST|/campaigns/:id/reserve': { kind: 'ad-spend', guard: 'state', pins: [['modules/ads/booking.service.ts', 'reserveAndHold', 'FOR UPDATE']] },
  'modules/ads/ads.routes.ts|POST|/campaigns/:id/checkout': { kind: 'ad-spend', guard: 'state', pins: [['modules/ads/checkout.service.ts', 'checkout', 'if (open) { invoice = open; return; }']] },
  // [#1964 review F2 S3-1] Money-bearing state transitions.
  'modules/rider/rider.routes.ts|PUT|/orders/:id/delivered': transition('payout', 'modules/rider/rider.routes.ts', "allowedFrom: ['ARRIVED', 'EN_ROUTE_DELIVERY']", [['modules/rider/rider.routes.ts', H, "withIdempotency(app, request, 'delivered', id"], EARNINGS]),
  [`${VENDOR}|PUT|/orders/:id/delivered`]: transition('payout', VENDOR, "allowedFrom: ['READY_FOR_PICKUP'],", [EARNINGS]),
  'modules/driver/driver.routes.ts|PUT|/rides/:id/complete': { kind: 'payout', guard: 'state', pins: [['modules/driver/driver.routes.ts', H, "allowedFrom: ['RIDE_IN_PROGRESS'],"], [ORDER_SVC, 'transitionOrderAtomically', 'this.stageCanonicalOrderTransition(tx, input)'], ...ORDER_CAS, EARNINGS] },
  'modules/rider/rider.routes.ts|POST|/orders/:id/handover': { kind: 'payment-claim', guard: 'state', pins: [['modules/rider/rider.routes.ts', H, "withIdempotency(app, request, 'handover', id"], HANDOVER] },
  'modules/driver/driver.routes.ts|POST|/rides/:id/handover': { kind: 'payment-claim', guard: 'state', pins: [['modules/driver/driver.routes.ts', H, "withIdempotency(app, request, 'handover', id"], HANDOVER] },
  'modules/courier/courier.routes.ts|POST|/order/:id/collect': { kind: 'payment-claim', guard: 'state', pins: [['modules/cash/cash-rules.service.ts', 'collectFromSender', "if (claimed.count !== 1) throw new AppError(409, 'ALREADY_COLLECTED'"]] },
  [`${CUSTOMER}|POST|/orders/:id/cancel`]: { kind: 'refund', guard: 'state', pins: [[CUSTOMER, H, 'orderService.cancelOrder('], ...CANCEL] },
  'modules/rides/rides.routes.ts|POST|/:id/cancel': { kind: 'refund', guard: 'state', pins: [['modules/rides/rides.routes.ts', H, 'orderService.cancelOrder('], ...CANCEL] },
  'modules/courier/courier.routes.ts|POST|/order/:id/cancel': transition('refund', 'modules/courier/courier.routes.ts', 'allowedFrom: COURIER_CANCELLABLE_STATUSES,'),
  [`${ADMIN}|PUT|/orders/:id/cancel`]: transition('refund', ADMIN, '.filter((status) => !(TERMINAL_ORDER_STATUSES as string[]).includes(status))'),
  'modules/ads/ads.routes.ts|POST|/campaigns/:id/cancel': { kind: 'refund', guard: 'state', pins: [['modules/ads/ads.routes.ts', H, "lifecycle.transition(request.params.id, 'cancel'"], ['modules/ads/lifecycle.service.ts', 'transition', 'where: { id: campaignId, status: before.status },'], ['modules/ads/refund.service.ts', 'stage', 'if (existing) return { intentId: existing.id, staged: false']] },
  // [#1964 delta review F2 S4-3] The store's compound terminals.
  [`${VENDOR}|PUT|/orders/:id/complete-pickup`]: transition('payment-claim', VENDOR, "allowedFrom: ['READY_FOR_PICKUP'], expectedFulfillment: 'PICKUP',"),
  [`${VENDOR}|PUT|/orders/:id/complete-appointment`]: { kind: 'payout', guard: 'state', pins: [[VENDOR, H, "if (order.status !== 'ACCEPTED')"], [ORDER_SVC, 'updateStatus', 'const allowedFrom = opts?.allowedFrom ?? ORDER_TRANSITIONS[target];'], ...ORDER_CAS] },
  // [#1972] A retried service request returns the first job: same customer, provider, words and photos,
  // still REQUESTED, within the window, found under the customer's User-row lock. No key needed (builds 9/11).
  'modules/services/services.routes.ts|POST|/jobs': { kind: 'order', guard: 'state', pins: [
    [SERVICES_SVC, 'createServiceJobWithLiveAuthority', 'FOR UPDATE /* service-job-live-authority */'],
    [SERVICES_SVC, 'createServiceJobWithLiveAuthority', 'createdAt: { gte: new Date(Date.now() - SERVICE_JOB_RETRY_WINDOW_MS) },'],
    [SERVICES_SVC, 'createServiceJobWithLiveAuthority', 'if (earlier) return { job: earlier, created: false as const };'],
    ['modules/services/services.routes.ts', H, 'if (!created) {'],
  ] },
  // A tip after delivery is refused until a collection path exists.
  [`${CUSTOMER}|POST|/orders/:id/tip`]: { kind: 'payout', guard: 'refused', pins: [['modules/order/order.service.ts', 'addPostDeliveryTip', 'TIP_COLLECTION_UNAVAILABLE']] },
};

/** Verb-matched routes that create none of the eight things (reviewed). */
const OUT: Record<string, string> = {
  [`${CUSTOMER}|POST|/orders/:id/reorder`]: 'Fills the CART from a past order; nothing is ordered until checkout (which holds its own key).',
  [`${CUSTOMER}|PUT|/cart/tip`]: 'Sets the tip VALUE on the cart (a replay sets the same value); the money moves at checkout.',
  'modules/ads/ads.routes.ts|POST|/campaigns': 'Creates a DRAFT campaign; no money is reserved or charged until reserve / checkout (both guarded).',
  'modules/courier/courier.routes.ts|POST|/order/:id/return': 'A state transition of an existing parcel (return to sender), not a new parcel; the parcel state machine refuses a second one.',
  'modules/billing/card-rail.routes.ts|POST|/return': 'The card page returning to Swift: it credits nothing itself (the card rail is off, and a card payment is credited only after the provider\'s own lookup).',
  'modules/services/services.routes.ts|POST|/jobs/:id/confirm': 'The provider affirms a scheduled slot: a state transition (from SCHEDULED, bound to expectedUpdatedAt), not a new job.',
  'modules/safety/safety.routes.ts|POST|/sos/:id/confirm': 'Safety: confirms an existing SOS; it creates no order or money.',
  'modules/safety/safety.routes.ts|POST|/sos/:id/resolve': 'Safety: resolves an existing SOS; it creates no order or money.',
  'modules/vendor/vendor.routes.ts|POST|/items/:id/adjust': 'A stock count adjustment on the store\'s item (inventory), not an order or money.',
  'modules/vendor/vendor.routes.ts|POST|/items/import/sync/confirm': 'Applies a till export to the store\'s own items (stock counts and prices), not an order or money. A replay is still a no-op: the upload id is the pos_imports row id, so a retried confirm returns the stored result, and (store, file hash) is unique.',
  'modules/vendor/vendor.routes.ts|POST|/store-categories/request': 'Asks Swift to add a store category; no order or money.',
  [`${ADMIN}|POST|/orders/:id/food-age-hold/release`]: 'Releases an age hold on an existing order (C2 workflow state), not a new order or money.',
  [`${ADMIN}|POST|/integrity/appeals/:id/resolve`]: 'Decides an integrity appeal (C3); it creates no order or money.',
  [`${ADMIN}|PUT|/verification/legal-holds/:id/release`]: 'Releases a legal hold on a verification record; no order or money.',
  [`${ADMIN}|POST|/verification/cases/:id/release`]: 'Releases a verification case back to the queue; no order or money.',
  [`${ADMIN}|POST|/upload-scan-debts/:id/release`]: 'Rescans an upload held by the malware scanner and releases it only if the scan is clean (scan-ledger state + audit row); no order or money. A replay finds it NOT_HELD (409).',
  [`${ADMIN}|PUT|/support/:id/resolve`]: 'Marks a support ticket resolved; no order or money.',
  [`${ADMIN}|POST|/compliance/violations/:id/resolve`]: 'Resolves a compliance violation record; no order or money.',
  [`${ADMIN}|POST|/discovery/backfill`]: 'Rebuilds discovery/search projections; no order or money.',
  [`${ADMIN}|POST|/rating-reports/:id/resolve`]: 'Decides a reported rating; no order or money.',
  // [#1964 review F2 S3-1 / G S4-1] Transitions and nouns now read, that create none of the eight.
  'modules/rider/rider.routes.ts|POST|/orders/:id/accept': 'A rider takes an existing order (assignment under the order lock); no new order and no money row — earnings come at delivered.',
  // [#1995 ads security] Accepting one's own advertiser team invitation creates nothing: one compare-and-set
  // (updateMany where acceptedAt is null, the invitee's own row, unexpired) sets acceptedAt; a retry finds no
  // open invitation and answers 404. No order, no money row, no new row.
  'modules/ads/ads.routes.ts|POST|/advertiser/:id/members/accept': 'The invited person accepts their own open invitation: one compare-and-set on their row (acceptedAt null -> now); a retry finds nothing open (404). Creates no row and moves no money.',
  'modules/rider/rider.routes.ts|POST|/offers/accept': 'A rider takes an offered order (the offer is claimed once); assignment only, no money row.',
  'modules/driver/driver.routes.ts|POST|/rides/:id/accept': 'A driver takes an existing ride request (assignment); the fare is earned at complete, not here.',
  'modules/driver/driver.routes.ts|POST|/offers/accept': 'A driver takes an offered ride (the offer is claimed once); assignment only, no money row.',
  'modules/driver/driver.routes.ts|POST|/rides/:id/cancel': 'The driver gives the ride back (PENDING, driver cleared) under the taxi custody lock; the customer is not refunded or charged here.',
  [`${VENDOR}|PUT|/orders/:id/accept`]: 'The store accepts an order (PENDING -> ACCEPTED through the order compare-and-set); no money row.',
  'modules/services/services.routes.ts|POST|/jobs/:id/quote': 'The provider names a price (bound to expectedUpdatedAt); service money is paid to the provider directly, Swift records no money row.',
  'modules/services/services.routes.ts|POST|/jobs/:id/complete': 'Marks a service job done (bound to expectedUpdatedAt); no money row on Swift.',
  'modules/services/services.routes.ts|POST|/jobs/:id/cancel': 'Cancels a service request (bound to expectedUpdatedAt); nothing was charged, so nothing is refunded.',
  'modules/safety/safety.routes.ts|POST|/sos/:id/cancel': 'Safety: cancels an existing SOS; it creates no order or money.',
  [`${CUSTOMER}|POST|/team-invites/:id/accept`]: 'Joins an advertiser/store team; no order or money.',
  [`${ADMIN}|POST|/ads/house`]: 'Uploads a house (Swift\'s own) ad creative; no advertiser, invoice or spend.',
  [`${ADMIN}|POST|/approvals/:id/cancel`]: 'An admin withdraws their own pending approval request; nothing is executed.',
};

/** Real gaps, each with its own server-fix PR to come (tolerated while listed). */
const PENDING_FIX: Record<string, string> = {
  // Empty: POST /services/jobs (the one gap) is fixed by #1972 and now sits in SCOPE.
};

/** Registrations the census cannot read (reviewed): not a creator of the eight. */
const UNREADABLE: Record<string, string> = {
  'modules/rider/rider.routes.ts|PUT|`/orders/:id/${slug}`': "The rider's in-transit steps from STATUS_TRANSITIONS (en-route-pickup, arrived-pickup, picked-up, en-route-delivery, arrived): each moves the status through the order compare-and-set; no money row (earnings at delivered, cash at handover).",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', '__tests__', '__mocks__'].includes(e.name) ? [] : sources(p);
    return /\.ts$/.test(e.name) && !/\.(test|spec|census)\.|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}
const FILES = Object.fromEntries(sources(join(SRC, 'modules')).map((p) => [relative(SRC, p), readFileSync(p, 'utf8')]));
/** The approval gate itself: every C4/C5 admin request spends its approval once, before the handler. */
// [#2086] The spend's compare-and-set also carries the expiry (a lapsed approval never spends): the pin follows it.
const GATE: Pin[] = [['modules/admin/admin-approval.ts', 'markApplied', "where: { id: approvalId, status: 'APPROVED', expiresAt: { gt: now } }"], ['modules/admin/admin-approval.ts', 'resolveApproval', 'markApplied(prisma, approvalId, now)']];
const RESULT = census(FILES, SCOPE, OUT, PENDING_FIX, GATE);

describe('[BUG-GUARDS C2 · server] a retried request never creates twice', () => {
  it('reads the routes and covers all eight kinds (the census is not vacuous)', () => {
    expect(RESULT.routes).toBeGreaterThanOrEqual(350);
    expect(RESULT.inScope.length).toBeGreaterThanOrEqual(40);
    const kinds = new Set(Object.values(SCOPE).map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['ad-spend', 'fee-checkout', 'order', 'parcel', 'payment-claim', 'payout', 'refund', 'ride']);
  });

  it('every create/money-verb route is classified (in scope, out with a reason, or approval-gated admin money)', () => {
    expect(RESULT.unclassified, 'classify it: SCOPE with its guard and a pin, or OUT with the reason it creates none of the eight').toEqual([]);
    for (const [id, reason] of [...Object.entries(OUT), ...Object.entries(PENDING_FIX)]) expect(reason.trim().length, id).toBeGreaterThanOrEqual(20);
  });

  it('every route registration is one the census can read (a *.routes.ts file, a literal path)', () => {
    expect(RESULT.unreadable, 'move it into a *.routes.ts file with a literal path, or list it here with its reason').toEqual(Object.keys(UNREADABLE));
    for (const [id, reason] of Object.entries(UNREADABLE)) expect(reason.trim().length, id).toBeGreaterThanOrEqual(20);
  });

  it("every listed route still exists, and every guard is still in the code (the pins)", () => {
    expect(RESULT.missingRoutes, 'a listed route is gone or moved: update its entry').toEqual([]);
    expect(RESULT.brokenPins).toEqual([]);
  });

  it('bites: an unguarded creator is unclassified, a removed guard breaks its pin, a C4 admin route is gated', () => {
    const route = (handler: string) => ({ 'modules/x/x.routes.ts': `export function r(app) { app.post('/order', async (req) => { ${handler} }); }` });
    const one: Record<string, Entry> = { 'modules/x/x.routes.ts|POST|/order': { kind: 'parcel', guard: 'key', pins: [['modules/x/x.routes.ts', '', 'withIdempotency(']] } };
    // A new creator nobody classified.
    expect(census(route('return create(req.body);'), {}, {}, {}, []).unclassified).toEqual(['modules/x/x.routes.ts|POST|/order']);
    // Classified with its key: holds; the key removed: the pin breaks.
    expect(census(route('return withIdempotency(app, req, "p", "s", () => create(req.body));'), one, {}, {}, []).brokenPins).toEqual([]);
    expect(census(route('return create(req.body);'), one, {}, {}, []).brokenPins).toHaveLength(1);
    // A pin into a named function.
    const svc = { 'modules/x/x.service.ts': `export async function confirm(id) { return prisma.s.updateMany({ where: { id, status: 'OWED' } }); }` };
    const pinned: Record<string, Entry> = { 'modules/x/x.routes.ts|POST|/order': { kind: 'payout', guard: 'state', pins: [['modules/x/x.service.ts', 'confirm', "status: 'OWED'"]] } };
    expect(census({ ...route('return confirm(req.id);'), ...svc }, pinned, {}, {}, []).brokenPins).toEqual([]);
    expect(census({ ...route('return confirm(req.id);'), 'modules/x/x.service.ts': svc['modules/x/x.service.ts'].replace("status: 'OWED'", '') }, pinned, {}, {}, []).brokenPins).toHaveLength(1);
    // [#1964 review F2 S3-1] A money transition is read too: an unguarded settlement on delivered is unclassified (M-F2-62/63).
    const at = (method: string, path: string, handler = 'return settle(req.id);') => ({ 'modules/x/x.routes.ts': `export function r(app) { app.${method}('${path}', async (req) => { ${handler} }); }` });
    expect(census(at('put', '/orders/:id/delivered'), {}, {}, {}, []).unclassified).toEqual(['modules/x/x.routes.ts|PUT|/orders/:id/delivered']);
    expect(census(at('put', '/orders/:id/cancel'), {}, {}, {}, []).unclassified).toEqual(['modules/x/x.routes.ts|PUT|/orders/:id/cancel']);
    for (const seg of ['complete', 'handover', 'collect', 'quote', 'accept', 'complete-pickup', 'complete-appointment']) expect(census(at('post', `/orders/:id/${seg}`), {}, {}, {}, []).unclassified, seg).toHaveLength(1);
    // [#1964 review F2 S4-2] A registration outside *.routes.ts, or with a computed path, is reported (M-F2-64).
    expect(census({ 'modules/x/x.plugin.ts': `export function r(app) { app.post('/orders/:id/payout', async () => ({})); }` }, {}, {}, {}, []).unreadable).toEqual(["modules/x/x.plugin.ts|POST|'/orders/:id/payout'"]);
    expect(census({ 'modules/x/x.routes.ts': 'export function r(app) { app.post(PATH, async () => ({})); }' }, {}, {}, {}, []).unreadable).toEqual(['modules/x/x.routes.ts|POST|PATH']);
    expect(census({ 'modules/x/x.service.ts': `export async function f(http) { return http.get('/v1/rate'); }` }, {}, {}, {}, []).unreadable).toEqual([]);
    // [#1964 review F2 S4-1] A state pin names the where clause: another updateMany left in the handler does not keep it green.
    const cas: Record<string, Entry> = { 'modules/x/x.routes.ts|PUT|/orders/:id/delivered': { kind: 'payout', guard: 'state', pins: [['modules/x/x.routes.ts', '', "status: 'READY'"]] } };
    expect(census(at('put', '/orders/:id/delivered', "await db.o.updateMany({ where: { id, status: 'READY' } }); await db.log.updateMany({});"), cas, {}, {}, []).brokenPins).toEqual([]);
    expect(census(at('put', '/orders/:id/delivered', 'await db.o.updateMany({ where: { id } }); await db.log.updateMany({});'), cas, {}, {}, []).brokenPins).toHaveLength(1);
    // Admin: a C4 route is approval-gated; a non-money admin route still needs a classification.
    const admin = (method: string, path: string) => ({ [ADMIN]: `export function a(app) { app.${method}('${path}', async () => {}); }` });
    expect(census(admin('post', '/cash-rules/rlp/reserve/adjust'), {}, {}, {}, []).byApproval).toEqual([`${ADMIN}|POST|/cash-rules/rlp/reserve/adjust`]);
    expect(census(admin('post', '/integrity/appeals/:id/resolve'), {}, {}, {}, []).unclassified).toEqual([`${ADMIN}|POST|/integrity/appeals/:id/resolve`]); // C3
    // An entry listed as approval-gated whose class needs no second admin is refused.
    expect(census(admin('post', '/orders/:id/retry-dispatch'), { [`${ADMIN}|POST|/orders/:id/retry-dispatch`]: approval('order') }, {}, {}, []).brokenPins).toHaveLength(1); // C2
  });
});
