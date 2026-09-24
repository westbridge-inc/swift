// ---------------------------------------------------------------------------
// [DS110-14] THE REASON CENSUS — one list, graded at the wire.
//
// Every admin-console caller of a server route that demands a stated reason
// (C3/C4/C5 in `ADMIN_ROUTE_AUTHORITY`) is registered here, and the census
// test grades each one by invoking its api helper with a reason and asserting
// the outgoing request carries it (the `x-swift-reason` header the single
// transport puts on every reasoned call). A console caller left off this list
// fails the census; a server route with no console caller is allowed to be
// absent.
//
// `helper` names an export of `lib/api.ts`; `args` are the helper's
// NON-reason arguments in call order — every reasoned helper takes its reason
// as the FINAL argument, so the test can drive all of them identically.
// `requiredBodyKeys` names the top-level body fields the SERVER's zod schema
// demands (read from the route handler), so the census grades the body shape
// at the wire and not just the reason — a helper that passed the reason gate
// and then 400'd on a missing `note` / deposit evidence is caught here.
// ---------------------------------------------------------------------------

export interface ReasonCaller {
  /** "<METHOD> <route template>", exactly as ADMIN_ROUTE_AUTHORITY keys it. */
  readonly route: string;
  /** The exported function name in lib/api.ts. */
  readonly helper: string;
  /** The helper's non-reason arguments, in call order. */
  readonly args: readonly unknown[];
  /** Top-level body fields the server's zod schema requires; absent = none. */
  readonly requiredBodyKeys?: readonly string[];
}

export const REASONED_CALLERS: readonly ReasonCaller[] = [
  // ── People ─────────────────────────────────────────────────────────────
  { route: 'PUT /users/:id/suspend', helper: 'suspendUser', args: ['usr_1'] },
  { route: 'PUT /users/:id/unsuspend', helper: 'unsuspendUser', args: ['usr_1'] },
  { route: 'PUT /users/:id/ban', helper: 'banUser', args: ['usr_1'] },

  // ── Vendors and movers ─────────────────────────────────────────────────
  { route: 'PUT /vendors/:id/approve', helper: 'approveVendor', args: ['vnd_1'] },
  { route: 'PUT /vendors/:id/suspend', helper: 'suspendVendor', args: ['vnd_1'] },
  { route: 'PUT /riders/:id/verify-documents', helper: 'verifyRiderDocuments', args: ['rdr_1'] },
  { route: 'PUT /drivers/:id/verify-documents', helper: 'verifyDriverDocuments', args: ['drv_1'] },
  { route: 'PUT /drivers/:id/ride-class', helper: 'setDriverRideClass', args: ['drv_1', 'COMFORT'], requiredBodyKeys: ['rideClass'] },

  // ── Orders ─────────────────────────────────────────────────────────────
  { route: 'PUT /orders/:id/cancel', helper: 'cancelOrder', args: ['ord_1', { refund: false }] },
  { route: 'PUT /orders/:id/refund-settled', helper: 'settleOrderRefund', args: ['ord_1', 'REF-1', 500], requiredBodyKeys: ['reference', 'amount'] },

  // ── Moderation ─────────────────────────────────────────────────────────
  { route: 'PUT /moderation/reports/:id', helper: 'resolveModerationReport', args: ['rep_1', { status: 'ACTIONED' }], requiredBodyKeys: ['status'] },
  { route: 'POST /ratings/:id/moderate', helper: 'moderateRating', args: ['rat_1', { action: 'publish' }], requiredBodyKeys: ['action'] },
  { route: 'POST /rating-reports/:id/resolve', helper: 'resolveRatingReport', args: ['rr_1', 'uphold'], requiredBodyKeys: ['action'] },

  // ── Ads ────────────────────────────────────────────────────────────────
  { route: 'PUT /ads/advertisers/:id/approve', helper: 'approveAdvertiser', args: ['adv_1'] },
  { route: 'PUT /ads/advertisers/:id/reject', helper: 'rejectAdvertiser', args: ['adv_1'], requiredBodyKeys: ['reason'] },
  { route: 'PUT /ads/advertisers/:id/suspend', helper: 'suspendAdvertiser', args: ['adv_1'], requiredBodyKeys: ['reason'] },
  { route: 'PUT /ads/advertisers/:id/reinstate', helper: 'reinstateAdvertiser', args: ['adv_1'] },

  // ── Verification ───────────────────────────────────────────────────────
  { route: 'PUT /verification/:id/approve', helper: 'approveDoc', args: ['doc_1', undefined] },
  { route: 'PUT /verification/:id/reject', helper: 'rejectDoc', args: ['doc_1'], requiredBodyKeys: ['reason'] },

  // ── Compliance ─────────────────────────────────────────────────────────
  { route: 'POST /compliance/reviews/:id/decide', helper: 'decideComplianceReview', args: ['cre_1', true, undefined], requiredBodyKeys: ['pass'] },
  { route: 'POST /compliance/violations/:id/resolve', helper: 'resolveComplianceViolation', args: ['vio_1'] },

  // ── Dead letters ───────────────────────────────────────────────────────
  { route: 'DELETE /dlq/:queue/:id', helper: 'discardDeadLetter', args: ['order', 'job-1', { name: 'process-billing', finishedOn: 1 }] },

  // ── Discovery ──────────────────────────────────────────────────────────
  { route: 'POST /discovery/categories/:id/merge-into', helper: 'mergeDiscoveryCategory', args: ['cat_1', 'cat_2'], requiredBodyKeys: ['targetId'] },

  // ── Finance, subscriptions, cash ───────────────────────────────────────
  { route: 'PUT /finance/settlements/:id/process', helper: 'processSettlement', args: ['set_1', undefined] },
  { route: 'PUT /subscriptions/:id/waive-fee', helper: 'waiveSubscriptionFee', args: ['sub_1'], requiredBodyKeys: ['reason'] },
  { route: 'POST /subscriptions/:id/topup', helper: 'topUpSubscription', args: ['sub_1', 1000, 'REF-1', 'idem-1'], requiredBodyKeys: ['amount', 'reference'] },
  { route: 'PUT /cash-rules/claims/:id/approve', helper: 'approveClaim', args: ['clm_1'] },
  { route: 'PUT /cash-rules/claims/:id/reject', helper: 'rejectClaim', args: ['clm_1'], requiredBodyKeys: ['reason'] },
  { route: 'PUT /cash-rules/claims/:id/paid', helper: 'payClaim', args: ['clm_1', 'REF-1', 500], requiredBodyKeys: ['reference', 'amount'] },
  { route: 'POST /cash-rules/rlp/reserve/adjust', helper: 'adjustRlpReserve', args: ['GY', 1000, 'Correction entry'], requiredBodyKeys: ['countryCode', 'amount', 'note'] },
  { route: 'PUT /cash-rules/rlp/movers/:userId/suspend', helper: 'suspendLossProtection', args: ['usr_2'], requiredBodyKeys: ['reason'] },
  { route: 'PUT /cash-rules/rlp/movers/:userId/reinstate', helper: 'reinstateLossProtection', args: ['usr_2', undefined] },
  { route: 'POST /billing/agent-payments/:id/attach', helper: 'attachAgentPayment', args: ['pay_1', 'sub_1'], requiredBodyKeys: ['subscriptionId'] },
  { route: 'POST /billing/agent-payments/:id/refund-flag', helper: 'flagAgentPaymentRefund', args: ['pay_1'], requiredBodyKeys: ['note'] },
  { route: 'POST /billing/settlement-batches/:id/confirm-deposit', helper: 'confirmSettlementDeposit', args: ['batch_1', { depositedGyd: 500, depositedAt: '2026-01-01T00:00:00Z', bankRef: 'MMG-BANK-REF-1' }], requiredBodyKeys: ['depositedGyd', 'depositedAt', 'bankRef'] },

  // ── Returns ────────────────────────────────────────────────────────────
  { route: 'PUT /returns/:id/resolve', helper: 'resolveReturn', args: ['ret_1', 'APPROVED', undefined], requiredBodyKeys: ['status'] },
  { route: 'PUT /returns/:id/refund-settled', helper: 'settleReturnRefund', args: ['ret_1', 'REF-1', 500, undefined], requiredBodyKeys: ['reference', 'amount'] },

  // ── Platform ───────────────────────────────────────────────────────────
  { route: 'POST /notifications/broadcast', helper: 'broadcastNotification', args: [{ title: 'T', body: 'B', category: 'service' }], requiredBodyKeys: ['title', 'body', 'category'] },
  { route: 'PUT /config/:key', helper: 'updateConfig', args: ['DELIVERY_FEE', { base: 100 }], requiredBodyKeys: ['value'] },
  { route: 'POST /promos', helper: 'createPromo', args: [{
    code: 'CENSUS', description: 'Census fixture', discountType: 'FIXED_AMOUNT', discountValue: 1,
    validFrom: '2026-01-01', validUntil: '2026-02-01',
  }], requiredBodyKeys: ['code', 'description', 'discountType', 'discountValue', 'validFrom', 'validUntil'] },

  // ── The decision itself ────────────────────────────────────────────────
  { route: 'POST /approvals/:id/decide', helper: 'decideApproval', args: ['apr_1', true], requiredBodyKeys: ['approve'] },
] as const;
