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

export interface AdminRouteAuthority {
  readonly cls: AdminActionClass;
  readonly capability: string;
}

/** `"<METHOD> <route template>"`, exactly as Fastify reports `routeOptions.url`. */
export type AdminRouteKey = string;

const c = (cls: AdminActionClass, capability: string): AdminRouteAuthority => ({ cls, capability });

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
  'PUT /users/:id/suspend': c('C3', 'user.suspend'),
  'PUT /users/:id/unsuspend': c('C3', 'user.suspend'),
  'PUT /users/:id/ban': c('C3', 'user.ban'),

  // ── Vendors ─────────────────────────────────────────────────────────────
  'GET /vendors': c('C0', 'vendor.read'),
  'GET /vendors/pending': c('C0', 'vendor.read'),
  'GET /vendors/:id': c('C1', 'vendor.read'),
  'PUT /vendors/:id/approve': c('C3', 'vendor.approve'),
  'PUT /vendors/:id/suspend': c('C3', 'vendor.suspend'),
  'PUT /vendors/:id/feature': c('C2', 'vendor.feature'),

  // ── Movers ──────────────────────────────────────────────────────────────
  'GET /riders': c('C1', 'mover.read'),
  'GET /riders/:id': c('C1', 'mover.read'),
  'PUT /riders/:id/verify-documents': c('C3', 'mover.verify'),
  'GET /drivers': c('C1', 'mover.read'),
  'GET /drivers/:id': c('C1', 'mover.read'),
  'PUT /drivers/:id/verify-documents': c('C3', 'mover.verify'),
  'PUT /drivers/:id/ride-class': c('C3', 'driver.rideclass'),

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
  'PUT /orders/:id/cancel': c('C3', 'order.cancel'),
  'PUT /orders/:id/refund-settled': c('C4', 'order.refund.settle'),

  // ── Moderation ──────────────────────────────────────────────────────────
  'GET /moderation/reports': c('C1', 'moderation.read'),
  'PUT /moderation/reports/:id': c('C3', 'moderation.decide'),
  'GET /ratings/moderation': c('C1', 'moderation.read'),
  'GET /ratings/at-risk': c('C1', 'moderation.read'),
  'POST /ratings/:id/moderate': c('C3', 'moderation.decide'),
  'POST /rating-reports/:id/resolve': c('C3', 'moderation.decide'),

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
  'PUT /finance/settlements/:id/process': c('C4', 'finance.settlement.process'),
  'POST /finance/settlements/:id/adjust': c('C4', 'finance.settlement.adjust'),

  // ── Platform configuration ──────────────────────────────────────────────
  'GET /config': c('C0', 'platform.config.read'),
  'PUT /config/:key': c('C5', 'platform.config.write'),
  'GET /promos': c('C0', 'platform.promo.read'),
  'POST /promos': c('C5', 'platform.promo.write'),
  'PUT /promos/:id': c('C5', 'platform.promo.write'),
  'POST /promos/:id/rollback': c('C5', 'platform.promo.write'),
  'DELETE /promos/:id': c('C5', 'platform.promo.write'),
  'GET /zones': c('C0', 'platform.zone.read'),
  'POST /zones': c('C5', 'platform.zone.write'),
  'PUT /zones/:id': c('C5', 'platform.zone.write'),
  'DELETE /zones/:id': c('C5', 'platform.zone.write'),
  'POST /notifications/broadcast': c('C5', 'platform.broadcast'),

  // ── Subscriptions ───────────────────────────────────────────────────────
  'GET /subscriptions': c('C0', 'subscription.read'),
  'GET /subscriptions/:id/billing-events': c('C0', 'subscription.read'),
  'PUT /subscriptions/:id/waive-fee': c('C4', 'subscription.waive'),
  'POST /subscriptions/:id/topup': c('C4', 'subscription.topup'),

  // ── Ads ─────────────────────────────────────────────────────────────────
  'GET /ads/advertisers/queue': c('C0', 'ads.read'),
  'GET /ads/creatives/queue': c('C0', 'ads.read'),
  'GET /ads/refund-intents': c('C0', 'ads.read'),
  'GET /ads/revenue': c('C0', 'ads.read'),
  'GET /ads/inventory': c('C0', 'ads.read'),
  'GET /ads/campaigns': c('C0', 'ads.read'),
  'GET /ads/settings': c('C0', 'ads.read'),
  'GET /ads/house': c('C0', 'ads.read'),
  'PUT /ads/advertisers/:id/approve': c('C3', 'ads.advertiser.decide'),
  'PUT /ads/advertisers/:id/reject': c('C3', 'ads.advertiser.decide'),
  'PUT /ads/advertisers/:id/suspend': c('C3', 'ads.advertiser.suspend'),
  'PUT /ads/advertisers/:id/reinstate': c('C3', 'ads.advertiser.suspend'),
  'PUT /ads/creatives/:id/approve': c('C2', 'ads.creative.decide'),
  'PUT /ads/creatives/:id/reject': c('C2', 'ads.creative.decide'),
  'PUT /ads/campaigns/:id/kill': c('C3', 'ads.campaign.kill'),
  'POST /ads/refund-intents/:id/settle': c('C4', 'ads.refund.settle'),
  'POST /ads/refund-intents/backfill': c('C4', 'ads.refund.backfill'),
  'PUT /ads/invoices/:id/mark-paid': c('C4', 'ads.invoice.pay'),
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
  'POST /billing/agent-payments/:id/attach': c('C4', 'billing.payment.attach'),
  'POST /billing/agent-payments/:id/refund-flag': c('C4', 'billing.payment.flag'),
  'POST /billing/agent-payments/:id/note': c('C2', 'billing.payment.note'),
  'POST /billing/settlement-import': c('C4', 'billing.settlement.import'),
  'POST /billing/settlement-batches/:id/confirm-deposit': c('C4', 'billing.deposit.confirm'),
  'POST /billing/settlement-batches/:id/adjust-deposit': c('C4', 'billing.deposit.adjust'),
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
  'PUT /verification/:id/approve': c('C3', 'verification.decide'),
  'PUT /verification/:id/reject': c('C3', 'verification.decide'),
  'GET /verification/:id/document-url': c('C1', 'verification.document.read'),

  // ── Returns and cash rules ──────────────────────────────────────────────
  'GET /returns': c('C0', 'returns.read'),
  'PUT /returns/:id/resolve': c('C4', 'returns.resolve'),
  'PUT /returns/:id/refund-settled': c('C4', 'returns.refund.settle'),
  'GET /cash-rules/claims': c('C0', 'cashrules.read'),
  'GET /cash-rules/metrics': c('C0', 'cashrules.read'),
  'PUT /cash-rules/claims/:id/approve': c('C4', 'cashrules.claim.decide'),
  'PUT /cash-rules/claims/:id/reject': c('C4', 'cashrules.claim.decide'),
  'PUT /cash-rules/claims/:id/paid': c('C4', 'cashrules.claim.pay'),

  // ── Support, audit and the agent ────────────────────────────────────────
  'GET /audit-logs': c('C1', 'audit.read'),
  'GET /support': c('C1', 'support.read'),
  'PUT /support/:id/resolve': c('C2', 'support.resolve'),
  'GET /agent/approvals': c('C0', 'agent.read'),
  'GET /agent/audit': c('C1', 'agent.read'),
  'POST /agent/approvals/:id/approve': c('C3', 'agent.approval.decide'),
  'POST /agent/approvals/:id/reject': c('C3', 'agent.approval.decide'),

  // ── Compliance ──────────────────────────────────────────────────────────
  'GET /compliance': c('C0', 'compliance.read'),
  'POST /compliance/run': c('C2', 'compliance.run'),
  'POST /compliance/reviews/:id/decide': c('C3', 'compliance.decide'),
  'POST /compliance/violations/:id/resolve': c('C3', 'compliance.decide'),

  // ── Platform health and the dead-letter queue ───────────────────────────
  'GET /alerts/health': c('C0', 'ops.read'),
  'GET /dlq': c('C0', 'ops.read'),
  'POST /dlq/:queue/:id/requeue': c('C2', 'ops.dlq.requeue'),
  'DELETE /dlq/:queue/:id': c('C3', 'ops.dlq.delete'),

  // ── Discovery taxonomy ──────────────────────────────────────────────────
  'GET /discovery/categories': c('C0', 'discovery.read'),
  'GET /discovery/requests': c('C0', 'discovery.read'),
  'PUT /discovery/categories/:id': c('C2', 'discovery.write'),
  'POST /discovery/categories/:id/merge-into': c('C3', 'discovery.merge'),
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

/** A worked example, and the shape the red test uses: a support operator. */
export const SUPPORT_OPERATOR_CAPABILITIES: readonly string[] = [
  'dashboard.read', 'support.read', 'support.resolve', 'order.read', 'user.read', 'moderation.read',
];

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
