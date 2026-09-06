/**
 * [ADM-001] THE ADMIN AUTHORITY ENGINE.
 *
 * Appendix AJ measured the permission engine of this platform and found one
 * boolean:
 *
 *     if (!['ADMIN', 'SUPER_ADMIN'].includes(request.user.role))
 *
 * Behind it: ban a user, process a settlement, waive a fee, top up an account,
 * mark an invoice paid, set national pricing, change the batching algorithm,
 * broadcast to every user, delete a dead job. `Admin.permissions` existed in
 * the schema, was written as `['*']` by the seed, and was READ BY NOTHING — a
 * permission model in name only.
 *
 * This module is the answer to exactly one question, per request:
 *
 *     does this actor hold this capability for this action, right now?
 *
 * Three properties, and the census test in `admin-authority.test.ts` keeps
 * them true as routes are added:
 *
 *   1. EVERY admin route declares a class and a capability. A route that does
 *      not appear here is DENIED, not allowed — an unclassified route is an
 *      unreviewed one, and default-allow is how the one-boolean gate happened.
 *   2. The class says what the action IS (AJ.3): C0 read, C1 sensitive read,
 *      C2 operational, C3 consequential, C4 money, C5 platform. The later
 *      clauses hang off it — ADM-006 requires a reason for C3-C5, ADM-005 a
 *      second person for C4/C5, ADM-007 an access row for C1 — so the
 *      classification is the shared foundation, not decoration.
 *   3. The decision is server-side, at the route, before the handler.
 *
 * WHAT AN ACTOR HOLDS. `Admin.permissions` is now read: a non-empty list is
 * the actor's capability set, expressed as exact names (`finance.read`),
 * prefix wildcards (`finance.*`) or `*`. An admin with no Admin row, or an
 * empty list, falls back to their ROLE's container — which for ADMIN is
 * today's behaviour, deliberately, so this engine does not silently demote the
 * one live admin identity on the day it ships. What it changes is that
 * restricting an actor is now possible AND enforced: an operator granted
 * `['support.*', 'order.read']` is refused every settlement, waiver, price
 * change and broadcast, by the server, whatever the console lets them click.
 */
import type { FastifyRequest } from 'fastify';

/** AJ.3 — every admin action is one of these. */
export type AdminActionClass = 'C0' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5';

export interface AdminActionMeaning {
  readonly meaning: string;
  /** ADM-006: a reason is required to perform it. */
  readonly requiresReason: boolean;
  /** ADM-005: a second capable admin must approve it. */
  readonly requiresApproval: boolean;
}

/** The demands each class makes. ADM-001 enforces the capability; the reason
 *  and approval columns are the contract ADM-005/ADM-006 build on, stated here
 *  so the classification is done once. */
export const ADMIN_ACTION_CLASSES: Record<AdminActionClass, AdminActionMeaning> = {
  C0: { meaning: 'read — discloses nothing sensitive', requiresReason: false, requiresApproval: false },
  C1: { meaning: 'sensitive read — identity, location, document or secret', requiresReason: false, requiresApproval: false },
  C2: { meaning: 'operational — workflow state, reversible, no money', requiresReason: false, requiresApproval: false },
  C3: { meaning: "consequential — affects a person's access or livelihood", requiresReason: true, requiresApproval: false },
  C4: { meaning: 'money — moves, forgives, or claims settlement of value', requiresReason: true, requiresApproval: true },
  C5: { meaning: 'platform — pricing, config, algorithms, or broadcasts', requiresReason: true, requiresApproval: true },
};

/**
 * [ADM-004] The row an action changes.
 *
 * The audit trail recorded `{ params, body }` — the REQUEST, not the change.
 * An investigator could see that a route was called and not what it did, the
 * 2,000-character truncation lost the tail, and a raw body carried document
 * numbers, phones and addresses into a table with no privacy shaping.
 *
 * Where an action has one subject row, naming its model here lets the trail
 * record what that row looked like before and after — as digests and a
 * field-level diff of the fields that matter, never the payload.
 */
export interface AdminRouteEntity {
  /** The Prisma model, as it is named on the client (`subscription`, `order`). */
  readonly model: string;
  /** Which route param identifies it. Defaults to `id`. */
  readonly param?: string;
  /** The fields whose change is worth naming. The digest covers the whole row
   *  regardless, so this is what a reader sees first, not the limit of what is
   *  detected. */
  readonly fields: readonly string[];
}

export interface AdminRouteAuthority {
  readonly cls: AdminActionClass;
  readonly capability: string;
  readonly entity?: AdminRouteEntity;
}

/** `"<METHOD> <route template>"`, exactly as Fastify reports `routeOptions.url`. */
export type AdminRouteKey = string;

const c = (cls: AdminActionClass, capability: string, entity?: AdminRouteEntity): AdminRouteAuthority =>
  (entity ? { cls, capability, entity } : { cls, capability });

/** [ADM-004] Shorthands for the rows the admin surface changes most. */
const E = {
  user: { model: 'user', fields: ['status', 'activeRole', 'roles'] },
  vendor: { model: 'vendor', fields: ['status', 'isVerified', 'acceptingOrders', 'isFeatured'] },
  // [ADM-002] Rider/Driver never had `isVerified` or `status`; verification
  // lives in `documentsVerified*`, and a safety suspension is a timestamp.
  rider: { model: 'rider', fields: ['documentsVerified', 'documentsVerifiedAt', 'isAvailable', 'isOnline', 'safetySuspendedAt'] },
  driver: { model: 'driver', fields: ['documentsVerified', 'documentsVerifiedAt', 'isAvailable', 'isOnline', 'rideClass', 'safetySuspendedAt'] },
  // [ADM-002] `total` and `refundStatus` never existed on Order — declared
  // fields that the schema does not carry are silently skipped, so the diff
  // for every order route said nothing about money. These are the columns a
  // refund actually moves; the reference and the amount are the only proof
  // that a refund happened, and they belong in the trail as a diff.
  order: { model: 'order', fields: ['status', 'totalAmount', 'paymentStatus', 'cancelledAt', 'refundOwedAmount', 'refundOwedAt', 'refundRef', 'refundPaidAmount', 'refundSettledAt'] },
  subscription: { model: 'subscription', fields: ['status', 'feeWaived', 'weeklyRate', 'customRate', 'nextBillingDate'] },
  settlement: { model: 'settlement', fields: ['status', 'netSales', 'moverPayable', 'paidAt', 'reference'] },
  platformConfig: { model: 'platformConfig', param: 'key', fields: ['value'] },
  promo: { model: 'promoCode', fields: ['isActive', 'discountValue', 'validFrom', 'validUntil'] },
  zone: { model: 'zone', fields: ['isActive', 'name', 'priority'] },
  advertiser: { model: 'advertiser', fields: ['status'] },
  adCampaign: { model: 'adCampaign', fields: ['status'] },
  adInvoice: { model: 'adInvoice', fields: ['status', 'amount', 'paidAt'] },
  adRefundIntent: { model: 'adRefundIntent', fields: ['status', 'payoutRail', 'manualPayoutRef', 'providerRefundRef', 'completedAt'] },
  agentPayment: { model: 'mmgAgentPayment', fields: ['status', 'amount', 'subscriptionId'] },
  settlementBatch: { model: 'settlementBatch', fields: ['status', 'expectedNetGyd', 'depositedGyd', 'depositedAt', 'bankRef'] },
  verification: { model: 'verificationDocument', fields: ['status', 'reviewedAt'] },
  // [ADM-002] `resolvedAt` does not exist on ReturnRequest (`reviewedAt` does).
  returnRequest: { model: 'returnRequest', fields: ['status', 'refundAmount', 'reviewedAt', 'refundRef', 'refundPaidAmount', 'refundPaidAt'] },
  claim: { model: 'reimbursementClaim', fields: ['status', 'amount', 'paidAt', 'paymentRef', 'paidAmount', 'reviewedAt'] },
  contentReport: { model: 'contentReport', fields: ['status', 'disposition'] },
  rating: { model: 'rating', fields: ['isPublic', 'state', 'stateReason', 'flagged'] },
  ratingReport: { model: 'ratingReport', fields: ['status'] },
  approval: { model: 'privilegedApproval', fields: ['status', 'approvedBy', 'decidedAt'] },
  agentRequest: { model: 'agentActionRequest', fields: ['status', 'decidedBy', 'decidedAt'] },
  complianceReview: { model: 'complianceReviewCase', fields: ['status', 'decidedAt'] },
  complianceViolation: { model: 'complianceViolation', fields: ['actionTaken', 'resolvedAt'] },
  discoveryCategory: { model: 'discoveryCategory', fields: ['status', 'slug', 'name', 'sortWeight'] },
} as const satisfies Record<string, AdminRouteEntity>;

/**
 * Every admin route, classified. Grouped as the console groups them.
 * The census test asserts this is 1:1 with `admin.routes.ts` in both
 * directions, so a new route cannot ship unclassified and a deleted one cannot
 * leave a capability behind that nothing grants access to.
 */
export const ADMIN_ROUTE_AUTHORITY: Readonly<Record<AdminRouteKey, AdminRouteAuthority>> = {
  // ── Dashboard and search ────────────────────────────────────────────────
  'GET /dashboard/overview': c('C0', 'dashboard.read'),
  'GET /search': c('C1', 'search.read'),

  // ── People ──────────────────────────────────────────────────────────────
  'GET /users': c('C1', 'user.read'),
  'GET /users/:id': c('C1', 'user.read'),
  'GET /users/:id/risk': c('C1', 'user.risk.read'),
  'PUT /users/:id/suspend': c('C3', 'user.suspend', E.user),
  'PUT /users/:id/unsuspend': c('C3', 'user.suspend', E.user),
  'PUT /users/:id/ban': c('C3', 'user.ban', E.user),

  // ── Vendors ─────────────────────────────────────────────────────────────
  'GET /vendors': c('C0', 'vendor.read'),
  'GET /vendors/pending': c('C0', 'vendor.read'),
  'GET /vendors/:id': c('C1', 'vendor.read'),
  'PUT /vendors/:id/approve': c('C3', 'vendor.approve', E.vendor),
  'PUT /vendors/:id/suspend': c('C3', 'vendor.suspend', E.vendor),
  'PUT /vendors/:id/feature': c('C2', 'vendor.feature', E.vendor),

  // ── Movers ──────────────────────────────────────────────────────────────
  'GET /riders': c('C1', 'mover.read'),
  'GET /riders/:id': c('C1', 'mover.read'),
  'PUT /riders/:id/verify-documents': c('C3', 'mover.verify', E.rider),
  'GET /drivers': c('C1', 'mover.read'),
  'GET /drivers/:id': c('C1', 'mover.read'),
  'PUT /drivers/:id/verify-documents': c('C3', 'mover.verify', E.driver),
  'PUT /drivers/:id/ride-class': c('C3', 'driver.rideclass', E.driver),

  // ── Orders and live ops ─────────────────────────────────────────────────
  'GET /orders': c('C1', 'order.read'),
  'GET /orders/held': c('C0', 'order.read'),
  'GET /orders/sla-breaches': c('C0', 'order.read'),
  'GET /orders/:id': c('C1', 'order.read'),
  'GET /ops/live': c('C1', 'ops.live.read'),
  'POST /orders/:id/retry-dispatch': c('C2', 'order.dispatch'),
  'POST /orders/:id/food-age-hold/release': c('C2', 'order.hold.release'),
  'GET /orders/:id/handover-secret': c('C1', 'order.handover.read'),
  'POST /orders/:id/handover-secret/rotate': c('C2', 'order.handover.rotate'),
  'GET /orders/:id/customer-identity': c('C1', 'order.identity.read'),
  'PUT /orders/:id/cancel': c('C3', 'order.cancel', E.order),
  'PUT /orders/:id/refund-settled': c('C4', 'order.refund.settle', E.order),

  // ── Moderation ──────────────────────────────────────────────────────────
  'GET /moderation/reports': c('C1', 'moderation.read'),
  'PUT /moderation/reports/:id': c('C3', 'moderation.decide', E.contentReport),
  'GET /ratings/moderation': c('C1', 'moderation.read'),
  'GET /ratings/at-risk': c('C1', 'moderation.read'),
  'POST /ratings/:id/moderate': c('C3', 'moderation.decide', E.rating),
  'POST /rating-reports/:id/resolve': c('C3', 'moderation.decide', E.ratingReport),

  // ── National pricing (founder + default tenant) ─────────────────────────
  'GET /countries': c('C0', 'platform.pricing.read'),
  'GET /countries/:code/pricing': c('C0', 'platform.pricing.read'),
  'PUT /countries/:code/pricing/:kind': c('C5', 'platform.pricing.write'),
  'POST /countries/:code/pricing/:kind/rollback': c('C5', 'platform.pricing.write'),

  // ── Finance ─────────────────────────────────────────────────────────────
  'GET /finance/revenue': c('C0', 'finance.read'),
  'GET /finance/settlements': c('C0', 'finance.read'),
  'GET /finance/cash-settlements': c('C0', 'finance.read'),
  'GET /finance/payment-mix': c('C0', 'finance.read'),
  'PUT /finance/settlements/:id/process': c('C4', 'finance.settlement.process', E.settlement),
  'POST /finance/settlements/:id/adjust': c('C4', 'finance.settlement.adjust', E.settlement),

  // ── Platform configuration ──────────────────────────────────────────────
  'GET /config': c('C0', 'platform.config.read'),
  'PUT /config/:key': c('C5', 'platform.config.write', E.platformConfig),
  'GET /promos': c('C0', 'platform.promo.read'),
  'POST /promos': c('C5', 'platform.promo.write'),
  'PUT /promos/:id': c('C5', 'platform.promo.write', E.promo),
  'POST /promos/:id/rollback': c('C5', 'platform.promo.write', E.promo),
  'DELETE /promos/:id': c('C5', 'platform.promo.write', E.promo),
  'GET /zones': c('C0', 'platform.zone.read'),
  'POST /zones': c('C5', 'platform.zone.write'),
  'PUT /zones/:id': c('C5', 'platform.zone.write', E.zone),
  'DELETE /zones/:id': c('C5', 'platform.zone.write', E.zone),
  'POST /notifications/broadcast': c('C5', 'platform.broadcast'),

  // ── Subscriptions ───────────────────────────────────────────────────────
  'GET /subscriptions': c('C0', 'subscription.read'),
  'GET /subscriptions/:id/billing-events': c('C0', 'subscription.read'),
  'PUT /subscriptions/:id/waive-fee': c('C4', 'subscription.waive', E.subscription),
  'POST /subscriptions/:id/topup': c('C4', 'subscription.topup', E.subscription),

  // ── Ads ─────────────────────────────────────────────────────────────────
  'GET /ads/advertisers/queue': c('C0', 'ads.read'),
  'GET /ads/creatives/queue': c('C0', 'ads.read'),
  'GET /ads/refund-intents': c('C0', 'ads.read'),
  'GET /ads/revenue': c('C0', 'ads.read'),
  'GET /ads/inventory': c('C0', 'ads.read'),
  'GET /ads/campaigns': c('C0', 'ads.read'),
  'GET /ads/settings': c('C0', 'ads.read'),
  'GET /ads/house': c('C0', 'ads.read'),
  'PUT /ads/advertisers/:id/approve': c('C3', 'ads.advertiser.decide', E.advertiser),
  'PUT /ads/advertisers/:id/reject': c('C3', 'ads.advertiser.decide', E.advertiser),
  'PUT /ads/advertisers/:id/suspend': c('C3', 'ads.advertiser.suspend', E.advertiser),
  'PUT /ads/advertisers/:id/reinstate': c('C3', 'ads.advertiser.suspend', E.advertiser),
  'PUT /ads/creatives/:id/approve': c('C2', 'ads.creative.decide'),
  'PUT /ads/creatives/:id/reject': c('C2', 'ads.creative.decide'),
  'PUT /ads/campaigns/:id/kill': c('C3', 'ads.campaign.kill', E.adCampaign),
  'POST /ads/refund-intents/:id/settle': c('C4', 'ads.refund.settle', E.adRefundIntent),
  'POST /ads/refund-intents/backfill': c('C4', 'ads.refund.backfill'),
  'PUT /ads/invoices/:id/mark-paid': c('C4', 'ads.invoice.pay', E.adInvoice),
  'POST /ads/placements/seed': c('C2', 'ads.placement.write'),
  'PUT /ads/placements/:id': c('C2', 'ads.placement.write'),
  'PUT /ads/settings': c('C5', 'ads.settings.write'),
  'POST /ads/house': c('C2', 'ads.house.write'),
  'PUT /ads/house/:id': c('C2', 'ads.house.write'),

  // ── Trial integrity (founder) ───────────────────────────────────────────
  'GET /integrity/flags': c('C1', 'integrity.read'),
  'GET /integrity/kpis': c('C0', 'integrity.read'),
  'GET /integrity/appeals': c('C1', 'integrity.read'),
  'GET /integrity/identity/:userId': c('C1', 'integrity.identity.read'),
  'POST /integrity/appeals/:id/resolve': c('C3', 'integrity.appeal.decide'),
  'POST /integrity/exceptions': c('C3', 'integrity.exception.write'),
  'POST /integrity/backfill': c('C5', 'integrity.backfill'),

  // ── Billing, cash and settlement ────────────────────────────────────────
  'GET /billing/fx-rates': c('C0', 'billing.read'),
  'GET /billing/price-book': c('C0', 'billing.read'),
  'GET /billing/usd-summary': c('C0', 'billing.read'),
  'GET /billing/usd-migration/preview': c('C0', 'billing.read'),
  'GET /billing/fx-preview': c('C0', 'billing.read'),
  'GET /billing/agent-payments': c('C0', 'billing.read'),
  'GET /billing/agent-payments/unmatched': c('C0', 'billing.read'),
  'GET /billing/agent-cash-config': c('C0', 'billing.read'),
  'GET /billing/collections': c('C0', 'billing.read'),
  'GET /billing/cash-journal': c('C0', 'billing.read'),
  'GET /billing/settlement-batches': c('C0', 'billing.read'),
  'GET /billing/cash-kpis': c('C0', 'billing.read'),
  'GET /billing/san/:san': c('C1', 'billing.san.read'),
  'POST /billing/fx-rates': c('C5', 'platform.fx.write'),
  'PUT /billing/price-book': c('C5', 'platform.pricebook.write'),
  'PUT /billing/agent-cash-config': c('C5', 'platform.cashconfig.write'),
  'POST /billing/usd-migration/mode-a': c('C5', 'platform.migration.run'),
  'POST /billing/usd-migration/mode-b': c('C5', 'platform.migration.run'),
  'POST /billing/usd-migration/mode-b/rollback': c('C5', 'platform.migration.run'),
  'POST /billing/san-backfill': c('C4', 'billing.san.backfill'),
  'POST /billing/agent-payments': c('C4', 'billing.payment.record'),
  'POST /billing/agent-payments/:id/attach': c('C4', 'billing.payment.attach', E.agentPayment),
  'POST /billing/agent-payments/:id/refund-flag': c('C4', 'billing.payment.flag', E.agentPayment),
  'POST /billing/agent-payments/:id/note': c('C2', 'billing.payment.note', E.agentPayment),
  'POST /billing/settlement-import': c('C4', 'billing.settlement.import'),
  'POST /billing/settlement-batches/:id/confirm-deposit': c('C4', 'billing.deposit.confirm', E.settlementBatch),
  'POST /billing/settlement-batches/:id/adjust-deposit': c('C4', 'billing.deposit.adjust', E.settlementBatch),
  'POST /billing/collections/:subscriptionId/contact': c('C2', 'billing.collections.contact'),

  // ── Algorithms ──────────────────────────────────────────────────────────
  'GET /algo/eta/report': c('C0', 'algo.read'),
  'GET /algo/prep-time/shadow-report': c('C0', 'algo.read'),
  'GET /batching/shadow-report': c('C0', 'algo.read'),
  'GET /batching/evaluations': c('C0', 'algo.read'),
  'GET /batching/settings': c('C0', 'algo.read'),
  'PUT /batching/settings': c('C5', 'platform.algo.write'),

  // ── Rides ───────────────────────────────────────────────────────────────
  'GET /rides/vehicle-identity-queue': c('C0', 'rides.read'),
  'POST /rides/vehicle-identity-backfill': c('C2', 'rides.vehicle.backfill'),
  'PUT /rides/drivers/:id/vehicle-identity': c('C3', 'rides.vehicle.write'),

  // ── Verification ────────────────────────────────────────────────────────
  'GET /verification/queue': c('C0', 'verification.read'),
  // [DOC-1 §8.4 · P8-4] SUPPORT sees status counts, never a document, a name or a phone (DOC-INV-19).
  'GET /verification/queue/counts': c('C0', 'verification.counts'),
  'PUT /verification/:id/approve': c('C3', 'verification.decide', E.verification),
  'PUT /verification/:id/reject': c('C3', 'verification.decide', E.verification),
  'GET /verification/:id/document-url': c('C1', 'verification.document.read'),
  // [DOC-1 §9.4 · P9-4] Legal holds on a person's documents: placing or releasing
  // one decides whether evidence survives — consequential, a reason is owed.
  'GET /verification/legal-holds': c('C1', 'verification.hold.read'),
  'POST /verification/legal-holds': c('C3', 'verification.hold'),
  'PUT /verification/legal-holds/:id/release': c('C3', 'verification.hold', { model: 'docLegalHold', fields: ['releasedAt', 'releasedBy', 'releaseReason'] }),
  // [DOC-1 §8.6 · P8-6] Claiming a review case is workflow state; recusal is enforced in the service, server-side.
  'POST /verification/cases/:id/claim': c('C2', 'verification.case.claim', { model: 'reviewCase', fields: ['assignedTo', 'assignedAt'] }),
  'POST /verification/cases/:id/release': c('C2', 'verification.case.claim', { model: 'reviewCase', fields: ['assignedTo', 'assignedAt'] }),

  // ── Returns and cash rules ──────────────────────────────────────────────
  'GET /returns': c('C0', 'returns.read'),
  'PUT /returns/:id/resolve': c('C4', 'returns.resolve', E.returnRequest),
  'PUT /returns/:id/refund-settled': c('C4', 'returns.refund.settle', E.returnRequest),
  'GET /cash-rules/claims': c('C0', 'cashrules.read'),
  'GET /cash-rules/metrics': c('C0', 'cashrules.read'),
  'PUT /cash-rules/claims/:id/approve': c('C4', 'cashrules.claim.decide', E.claim),
  'PUT /cash-rules/claims/:id/reject': c('C4', 'cashrules.claim.decide', E.claim),
  'PUT /cash-rules/claims/:id/paid': c('C4', 'cashrules.claim.pay', E.claim),

  // ── Dual control (ADM-005) ──────────────────────────────────────────────
  // The queue is a read; the decision is consequential and owes a reason, but
  // is NOT itself C4 — otherwise approving would need approving. The act it
  // authorises is still gated on its own class when the requester re-issues it.
  'GET /approvals': c('C0', 'approvals.read'),
  'POST /approvals/:id/decide': c('C3', 'approvals.decide', E.approval),

  // ── Support, audit and the agent ────────────────────────────────────────
  'GET /audit-logs': c('C1', 'audit.read'),
  'GET /support': c('C1', 'support.read'),
  'PUT /support/:id/resolve': c('C2', 'support.resolve'),
  'GET /agent/approvals': c('C0', 'agent.read'),
  'GET /agent/audit': c('C1', 'agent.read'),
  'POST /agent/approvals/:id/approve': c('C3', 'agent.approval.decide', E.agentRequest),
  'POST /agent/approvals/:id/reject': c('C3', 'agent.approval.decide', E.agentRequest),

  // ── Compliance ──────────────────────────────────────────────────────────
  'GET /compliance': c('C0', 'compliance.read'),
  'POST /compliance/run': c('C2', 'compliance.run'),
  'POST /compliance/reviews/:id/decide': c('C3', 'compliance.decide', E.complianceReview),
  'POST /compliance/violations/:id/resolve': c('C3', 'compliance.decide', E.complianceViolation),

  // ── Platform health and the dead-letter queue ───────────────────────────
  'GET /alerts/health': c('C0', 'ops.read'),
  'GET /dlq': c('C0', 'ops.read'),
  'POST /dlq/:queue/:id/requeue': c('C2', 'ops.dlq.requeue'),
  'DELETE /dlq/:queue/:id': c('C3', 'ops.dlq.delete'),

  // ── Discovery taxonomy ──────────────────────────────────────────────────
  'GET /discovery/categories': c('C0', 'discovery.read'),
  'GET /discovery/requests': c('C0', 'discovery.read'),
  'PUT /discovery/categories/:id': c('C2', 'discovery.write', E.discoveryCategory),
  'POST /discovery/categories/:id/merge-into': c('C3', 'discovery.merge', E.discoveryCategory),
  'POST /discovery/requests/:id/approve': c('C2', 'discovery.decide'),
  'POST /discovery/requests/:id/map': c('C2', 'discovery.decide'),
  'POST /discovery/requests/:id/reject': c('C2', 'discovery.decide'),
  'POST /discovery/backfill': c('C2', 'discovery.backfill'),
};

/** Every capability the table names, once. */
export const ADMIN_CAPABILITIES: readonly string[] = [
  ...new Set(Object.values(ADMIN_ROUTE_AUTHORITY).map((a) => a.capability)),
].sort();

/**
 * The container each role carries when the actor has no explicit grant.
 *
 * ADMIN keeps today's reach on purpose: this engine ships enforcing, and
 * demoting the one live admin identity in the same change would be a second,
 * unreviewed decision wearing this one's clothes. What changes is that a grant
 * can now narrow an actor, and the server honours it.
 */
export const ROLE_DEFAULT_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  SUPER_ADMIN: ['*'],
  ADMIN: ['*'],
};

/** A worked example, and the shape the red test uses: a support operator. Counts only on the review queue (DOC-1 §8.4). */
export const SUPPORT_OPERATOR_CAPABILITIES: readonly string[] = [
  'dashboard.read', 'support.read', 'support.resolve', 'order.read', 'user.read', 'moderation.read',
  'verification.counts',
];

/**
 * [DOC-1 §8.4 · P8-4] The review console's roles, as capability PRESETS an admin
 * grant is made from — not user roles: an operator is an ADMIN whose grant is
 * one of these, and the server honours the narrowing. Registry administration
 * and legal holds belong to DOC_ADMIN alone; the clearance outcome to DOC_SENIOR
 * and above; SUPPORT never reads a document, a case's fields, or a PERSONAL
 * value (DOC-INV-19) — it reads counts.
 */
export const DOC_REVIEWER_CAPABILITIES: readonly string[] = [
  'dashboard.read', 'verification.read', 'verification.counts', 'verification.document.read', 'verification.decide', 'verification.case.claim',
];
export const DOC_SENIOR_CAPABILITIES: readonly string[] = [
  ...DOC_REVIEWER_CAPABILITIES, 'verification.clearance.read',
];
export const DOC_ADMIN_CAPABILITIES: readonly string[] = [
  'dashboard.read', 'verification.*',
];
export const REVIEW_CONSOLE_PRESETS: Readonly<Record<'DOC_REVIEWER' | 'DOC_SENIOR' | 'DOC_ADMIN' | 'SUPPORT', readonly string[]>> = {
  DOC_REVIEWER: DOC_REVIEWER_CAPABILITIES,
  DOC_SENIOR: DOC_SENIOR_CAPABILITIES,
  DOC_ADMIN: DOC_ADMIN_CAPABILITIES,
  SUPPORT: SUPPORT_OPERATOR_CAPABILITIES,
};

/** Does a held pattern cover a needed capability? `*`, `finance.*`, or exact. */
export function capabilityMatches(held: string, needed: string): boolean {
  if (held === '*') return true;
  if (held === needed) return true;
  if (held.endsWith('.*')) return needed.startsWith(held.slice(0, -1));
  return false;
}

export function holdsCapability(held: readonly string[], needed: string): boolean {
  return held.some((pattern) => capabilityMatches(pattern, needed));
}

/** What this actor may do: their explicit grant, else their role's container. */
export function capabilitiesOf(actor: { role?: string | null; permissions?: readonly string[] | null }): readonly string[] {
  const granted = actor.permissions?.filter((p) => typeof p === 'string' && p.length > 0) ?? [];
  if (granted.length > 0) return granted;
  return ROLE_DEFAULT_CAPABILITIES[actor.role ?? ''] ?? [];
}

/**
 * The authority a route demands. `null` means UNREGISTERED — and an
 * unregistered admin route is denied, never allowed: the census test exists so
 * this never happens by accident, and the deny exists so it is never a hole
 * when it does.
 */
export function authorityFor(method: string, routeUrl: string): AdminRouteAuthority | null {
  return ADMIN_ROUTE_AUTHORITY[`${method.toUpperCase()} ${routeUrl}`] ?? null;
}

export type AdminCapabilityMode = 'enforce' | 'shadow';

/**
 * AJ's rollout note says shadow-log for one release, then enforce. The default
 * here is ENFORCE, because there is exactly one admin identity today and it
 * holds `*`, so nothing is denied that is not denied on purpose. An operator
 * staging a fleet of scoped accounts sets `ADMIN_CAPABILITY_MODE=shadow` to
 * watch the decisions first; anything else, including a typo, enforces.
 */
export function capabilityMode(env: Record<string, string | undefined> = process.env): AdminCapabilityMode {
  return env['ADMIN_CAPABILITY_MODE'] === 'shadow' ? 'shadow' : 'enforce';
}

export interface CapabilityDecision {
  readonly allowed: boolean;
  readonly capability: string | null;
  readonly cls: AdminActionClass | null;
  readonly reason: 'granted' | 'missing-capability' | 'unregistered-route';
}

/** The whole engine, as one pure function. */
export function decideCapability(
  actor: { role?: string | null; permissions?: readonly string[] | null },
  method: string,
  routeUrl: string,
): CapabilityDecision {
  const authority = authorityFor(method, routeUrl);
  if (!authority) return { allowed: false, capability: null, cls: null, reason: 'unregistered-route' };
  const held = capabilitiesOf(actor);
  const allowed = holdsCapability(held, authority.capability);
  return {
    allowed,
    capability: authority.capability,
    cls: authority.cls,
    reason: allowed ? 'granted' : 'missing-capability',
  };
}

/**
 * The route template Fastify matched, minus the plugin's mount prefix — never
 * `request.url`, which carries the caller's data. The table is keyed on the
 * strings `admin.routes.ts` itself registers (`/users/:id`), so the mount
 * point (`/api/v1/admin`) is stripped here rather than baked into 167 keys
 * where a re-mount would silently unclassify every one of them.
 */
export function routeTemplateOf(
  request: Pick<FastifyRequest, 'url'> & { routeOptions?: { url?: string } },
  prefix = '',
): string {
  const template = request.routeOptions?.url ?? request.url;
  if (prefix && template.startsWith(prefix)) {
    const stripped = template.slice(prefix.length);
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  }
  return template;
}

// ─── [ADM-006] A consequential action states why ─────────────────────────────
//
// The record showed WHAT happened and never WHY, so a decision could not be
// reviewed, appealed or defended. No admin route validated a justification;
// 43 of the 68 C3-C5 routes took no reason field at all, and the console sent
// the literal string 'Suspended by admin' where one was accepted — a reason
// that reasons about nothing.
//
// The class decides. C3 (a person's access or livelihood), C4 (money) and C5
// (pricing, config, algorithms, broadcasts) must carry one; C0-C2 must not be
// burdened with one. It is checked centrally, from the same table the
// capability comes from, so a new route inherits the law by being classified
// rather than by someone remembering.

/** Long enough to be a sentence, short enough to type. Matches the length the
 *  handover reveal already demands for the same kind of decision. */
export const ADMIN_REASON_MIN = 12;
export const ADMIN_REASON_MAX = 500;

/**
 * The canned strings a screen sends when nobody was actually asked. These are
 * not a blocklist of words — they are the exact shapes the console shipped, and
 * the point is that a template cannot satisfy a requirement to explain. The
 * check is on the WHOLE reason: "Suspended by admin, repeated no-shows after
 * three warnings" is a real reason that happens to start with the template.
 */
const TEMPLATE_REASONS: readonly string[] = [
  'suspended by admin', 'banned by admin', 'cancelled by admin', 'waived by admin',
  'approved by admin', 'rejected by admin', 'resolved by admin', 'processed by admin',
  'admin action', 'no reason', 'n/a', 'none', 'test', 'testing', 'as discussed', 'per policy',
];

export type ReasonProblem = 'missing' | 'too-short' | 'too-long' | 'template';

/**
 * The header a caller may state the reason in.
 *
 * Twenty-three routes already take a free-text `reason` in the body, where it
 * is DOMAIN data — the waiver's reason is shown to the vendor, the ban's is
 * kept on the account — and those keep it. But a reason is a cross-cutting
 * concern, and some bodies are not a place to put one: `PUT
 * /countries/:code/pricing/:kind` parses its whole body as the pricing
 * document under a strict schema, so a `reason` key there is a malformed
 * price book, not an explanation. The header carries it for those, and for
 * every route that never had a field.
 */
export const ADMIN_REASON_HEADER = 'x-swift-reason';

/** The reason a caller stated, from either place. The header wins: a route
 *  whose body happens to contain the word is not thereby explained. */
function statedReason(body: unknown, headers?: Record<string, unknown>): unknown {
  const fromHeader = headers?.[ADMIN_REASON_HEADER];
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader;
  return (body as { reason?: unknown } | null | undefined)?.reason;
}

/**
 * What is wrong with the reason on this request, or null if nothing is.
 * A class that does not require one always returns null — an operational
 * action does not owe an explanation, and demanding one would train people to
 * type anything.
 */
export function reasonProblem(cls: AdminActionClass, body: unknown, headers?: Record<string, unknown>): ReasonProblem | null {
  if (!ADMIN_ACTION_CLASSES[cls].requiresReason) return null;
  const raw = statedReason(body, headers);
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'missing';
  const reason = raw.trim();
  if (reason.length < ADMIN_REASON_MIN) return 'too-short';
  if (reason.length > ADMIN_REASON_MAX) return 'too-long';
  if (TEMPLATE_REASONS.includes(reason.toLowerCase().replace(/[.!]+$/, ''))) return 'template';
  return null;
}

/** What the operator is told. Each one says what to do, not merely what failed. */
export function reasonRefusal(problem: ReasonProblem, cls: AdminActionClass): string {
  const what = cls === 'C4' ? 'moves money'
    : cls === 'C5' ? 'changes the platform for everyone'
      : "affects a person's access or livelihood";
  switch (problem) {
    case 'missing':
      return `This action ${what}. Say why, in a sentence — the record keeps it.`;
    case 'too-short':
      return `Say why in at least ${ADMIN_REASON_MIN} characters — a word is not a reason anyone can review.`;
    case 'too-long':
      return `Keep the reason under ${ADMIN_REASON_MAX} characters.`;
    case 'template':
      return 'That is the default text, not a reason. Say what actually happened.';
  }
}

/** The reason as it should be recorded: trimmed, never the raw body. */
export function reasonOf(body: unknown, headers?: Record<string, unknown>): string | null {
  const raw = statedReason(body, headers);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// ─── [ADM-004] What the audit row says happened ──────────────────────────────
//
// `changes` was `{ params, body }`: the REQUEST, with the body truncated at
// 2,000 characters. An investigator could see that a route was called and not
// what it changed; the truncation lost the tail; and a raw body carried
// document numbers, phone numbers and addresses into a table with no privacy
// shaping at all — a privacy problem created by the privacy control.
//
// The row now carries the subject's before and after digest and a diff of the
// declared fields. The digest covers the WHOLE row, so a change outside the
// declared set still shows as a different digest; the diff is what a reader
// sees first.

/** Routes whose action has no single subject row, and why. The census test
 *  holds this list closed: a C3-C5 route is either declared with an entity or
 *  named here with a reason a reviewer can check. */
export const ADMIN_ROUTES_WITHOUT_ENTITY: Readonly<Record<AdminRouteKey, string>> = {
  'POST /promos': 'creates the row; there is no before state to digest',
  'POST /zones': 'creates the row; there is no before state to digest',
  'POST /notifications/broadcast': 'addresses every user; the subject is the audience, not a row',
  'PUT /countries/:code/pricing/:kind': 'writes a versioned price book, which keeps its own before/after by version',
  'POST /countries/:code/pricing/:kind/rollback': 'pins an earlier price-book version; the version register is the record',
  'PUT /ads/settings': 'a tenant-wide settings singleton with no id in the route',
  'PUT /billing/price-book': 'a versioned price book; the version register is the record',
  'PUT /billing/agent-cash-config': 'a tenant-wide settings singleton with no id in the route',
  'PUT /batching/settings': 'a tenant-wide settings singleton with no id in the route',
  'POST /billing/fx-rates': 'creates a rate row; there is no before state to digest',
  'POST /billing/usd-migration/mode-a': 'a fleet-wide migration over many rows, not one subject',
  'POST /billing/usd-migration/mode-b': 'a fleet-wide migration over many rows, not one subject',
  'POST /billing/usd-migration/mode-b/rollback': 'a fleet-wide migration over many rows, not one subject',
  'POST /billing/san-backfill': 'a backfill over many rows, not one subject',
  'POST /billing/agent-payments': 'records a new payment; there is no before state to digest',
  'POST /billing/settlement-import': 'stages a file of many rows; the import batch is its own record',
  'POST /ads/refund-intents/backfill': 'a backfill over many rows, not one subject',
  'POST /integrity/backfill': 'a backfill over many rows, not one subject',
  'POST /integrity/exceptions': 'creates the grant; there is no before state to digest',
  'POST /verification/legal-holds': 'creates the hold; there is no before state to digest',
  'POST /integrity/appeals/:id/resolve': 'the appeal is founder-scoped and read through the integrity graph, not a tenant row',
  'PUT /rides/drivers/:id/vehicle-identity': 'writes vehicle identity across driver and ride rows; no single subject',
  'DELETE /dlq/:queue/:id': 'a queue job, not a database row',
};

/** The subject row this action changes, if it has one. */
export function entityFor(method: string, routeUrl: string): AdminRouteEntity | null {
  return authorityFor(method, routeUrl)?.entity ?? null;
}

/**
 * [ADM-002] Routes that stay on the backstop hook BY DESIGN. Each is a
 * fleet-wide operation — many rows, each in its own transaction, often with a
 * notification per row — so there is no single transaction for the audit row
 * to join; the backstop records the run, and `writer="backstop"` for these
 * four is expected, not a regression. The census test holds this list closed:
 * every other C4/C5 handler must call `auditWithin`, and a route listed here
 * must not.
 */
export const ADMIN_ROUTES_ON_BACKSTOP: Readonly<Record<AdminRouteKey, string>> = {
  'POST /billing/usd-migration/mode-a': 'fleet-wide: one 30-day notice per payer, each in its own transaction plus a notification; the run summary is the record',
  'POST /integrity/backfill': 'fleet-wide backfill over every account in batches; the report is the record',
  'POST /ads/refund-intents/backfill': 'fleet-wide: one refund intent per terminal campaign, each in its own transaction; dry-run by default',
  'POST /billing/san-backfill': 'fleet-wide: one SAN per subscription, each its own compare-and-set; no single transaction to join',
};
