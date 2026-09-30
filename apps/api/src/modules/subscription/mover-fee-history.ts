import type { Prisma, PrismaClient, Subscription } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/** A finance acknowledgment pins complete source facts, including the plain
 * references that Prisma relations do not cover. Hash inside PostgreSQL so
 * provider payloads and stored payment identities never enter the audit body.
 * New money, an altered instruction or a new ledger/receipt invalidates it. */
export async function moverSourceFinancialFingerprint(db: Db, source: Subscription): Promise<string> {
  const rows = await db.$queryRaw<Array<{ fingerprint: string }>>`
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'source', (SELECT to_jsonb(s) - ARRAY['updatedAt','billingConfirmationPausedAt','billingEnforcementDueAt','nextRetryAt','gracePeriodEnd'] FROM subscriptions s WHERE s.id=${source.id}),
      'wallet', (SELECT to_jsonb(w) FROM prepaid_balances w WHERE w."subscriptionId"=${source.id}),
      'payments', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM subscription_payments p WHERE p."subscriptionId"=${source.id}),
      'refunds', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM subscription_refunds r WHERE r."subscriptionId"=${source.id}),
      'events', (SELECT jsonb_agg(to_jsonb(e) - ARRAY['deliveredAt','noticeLeaseUntil','noticeLeaseToken','noticeSmsSentAt'] ORDER BY e.id) FROM billing_events e WHERE e."subscriptionId"=${source.id}),
      'topups', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM topup_commands t WHERE t."subscriptionId"=${source.id}),
      'agent', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM mmg_agent_payments a WHERE a."subscriptionId"=${source.id} OR (${source.san}::text IS NOT NULL AND regexp_replace(a."sanRaw",'[^0-9]','','g')=${source.san})),
      'provider', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM provider_payments p WHERE p."subscriptionId"=${source.id} OR p.id IN (SELECT a."providerPaymentId" FROM mmg_agent_payments a WHERE a."subscriptionId"=${source.id} OR (${source.san}::text IS NOT NULL AND regexp_replace(a."sanRaw",'[^0-9]','','g')=${source.san}))),
      'providerAliases', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.provider, a."aliasKey") FROM provider_payment_aliases a WHERE a."providerPaymentId" IN (SELECT p.id FROM provider_payments p WHERE p."subscriptionId"=${source.id} OR p.id IN (SELECT m."providerPaymentId" FROM mmg_agent_payments m WHERE m."subscriptionId"=${source.id} OR (${source.san}::text IS NOT NULL AND regexp_replace(m."sanRaw",'[^0-9]','','g')=${source.san})))),
      'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM fee_receipts r WHERE r."subscriptionId"=${source.id}),
      'contacts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM collection_contacts c WHERE c."subscriptionId"=${source.id}),
      'tombstone', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.san) FROM san_tombstones t WHERE t."subscriptionId"=${source.id} OR t.san=${source.san}),
      'instruments', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM payment_instruments i WHERE i."subscriptionId"=${source.id}),
      'sessions', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM card_sessions s WHERE s."subscriptionId"=${source.id}),
      'checkouts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM mmg_checkout_intents c WHERE c."subscriptionId"=${source.id}),
      'confirmationHolds', (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM payment_confirmation_holds h WHERE h."subscriptionId"=${source.id}),
      'observations', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM card_observations o WHERE o."subscriptionId"=${source.id} OR o."sessionId" IN (SELECT id FROM card_sessions WHERE "subscriptionId"=${source.id}) OR o."instrumentId" IN (SELECT id FROM payment_instruments WHERE "subscriptionId"=${source.id}) OR o."paymentId" IN (SELECT id FROM subscription_payments WHERE "subscriptionId"=${source.id})),
      'ledger', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM ledger_transactions l WHERE l."idempotencyKey"='opening:'||${source.id} OR l."idempotencyKey" LIKE 'ledger:success:'||${source.id}||':%' OR l."idempotencyKey" LIKE 'ledger:topup:'||${source.id}||':%' OR l.id IN (SELECT e."transactionId" FROM ledger_entries e WHERE e."subledgerId"=${source.id})),
      'entries', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM ledger_entries e WHERE e."subledgerId"=${source.id} OR e."transactionId" IN (SELECT l.id FROM ledger_transactions l WHERE l."idempotencyKey"='opening:'||${source.id} OR l."idempotencyKey" LIKE 'ledger:success:'||${source.id}||':%' OR l."idempotencyKey" LIKE 'ledger:topup:'||${source.id}||':%')),
      'imports', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM settlement_imports i WHERE ${source.san}::text IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.rows) r WHERE regexp_replace(r->>'sanRaw','[^0-9]','','g')=${source.san}))
    )::text,'UTF8')),'hex') AS fingerprint
  `;
  if (!rows[0]?.fingerprint) throw new Error('Mover source financial fingerprint unavailable');
  return rows[0].fingerprint;
}

/** Supported paid-history resolution needs proof of completed money and of
 * existing paid entitlement. Unsupported obligations remain held for finance;
 * this function never manufactures a paid period or moves an alias balance. */
export async function paidMoverResolutionBlocker(db: Db, sources: Subscription[], canonical: Subscription): Promise<string | null> {
  for (const s of sources) {
    if (s.status !== 'ACTIVE' || !s.autoRenew || !s.autoSuspendEnabled || s.isTrialActive || s.isInGracePeriod
      || s.gracePeriodEnd || s.suspendedAt || s.nextRetryAt || s.failedAttempts
      || s.feeWaived || s.customRate !== null || s.feeWaivedBy || s.feeWaivedReason) return 'SOURCE_RESTRICTIONS_REQUIRE_REVIEW';
    if (s.currencyCode !== canonical.currencyCode) return 'SOURCE_CURRENCY_REQUIRES_REVIEW';
    if (s.currentPeriodStart < canonical.currentPeriodStart || s.currentPeriodEnd > canonical.currentPeriodEnd
      || s.nextBillingDate > canonical.nextBillingDate) return 'PAID_ENTITLEMENT_NOT_COVERED';
    const linked = { subscriptionId: s.id };
    const [balance, unconfirmed, paidPeriod, refund, topup, agent, provider, session, tombstone, contacts, checkout, confirmation] = await Promise.all([
      db.prepaidBalance.findUnique({ where: linked }),
      db.subscriptionPayment.findFirst({ where: { ...linked, status: { not: 'CAPTURED' } }, select: { id: true } }),
      db.subscriptionPayment.findFirst({ where: { ...linked, status: 'CAPTURED', paidAt: { not: null }, periodStart: s.currentPeriodStart, periodEnd: s.currentPeriodEnd }, select: { id: true, amount: true } }),
      db.subscriptionRefund.findFirst({ where: linked, select: { id: true } }),
      db.topUpCommand.findFirst({ where: { ...linked, tailDoneAt: null }, select: { id: true } }),
      db.mmgAgentPayment.findFirst({ where: { OR: [linked, ...(s.san ? [{ sanNormalized: s.san }] : [])], status: { notIn: ['MATCHED', 'RESOLVED', 'RECONCILED'] } }, select: { id: true } }),
      db.providerPayment.findFirst({ where: { ...linked, status: { not: 'CREDITED' } }, select: { id: true } }),
      db.cardSession.findFirst({ where: { ...linked, status: { notIn: ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'] } }, select: { id: true } }),
      db.sanTombstone.findFirst({ where: linked, select: { san: true } }),
      db.collectionContact.findFirst({ where: linked, select: { id: true } }),
      db.mmgCheckoutIntent.findFirst({ where: { ...linked, status: { notIn: ['CONFIRMED', 'NOT_PAID'] } }, select: { id: true } }),
      db.paymentConfirmationHold.findFirst({ where: { ...linked, status: { in: ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'] } }, select: { id: true } }),
    ]);
    if (s.id !== canonical.id && balance && !balance.balance.equals(0)) return 'ALIAS_FUNDS_REQUIRE_EXISTING_MONEY_COMMAND';
    if (balance && balance.currencyCode !== s.currencyCode) return 'SOURCE_CURRENCY_REQUIRES_REVIEW';
    if (unconfirmed || refund || topup || agent || provider || session || tombstone || contacts || checkout || confirmation) return 'SOURCE_OBLIGATIONS_REQUIRE_RECONCILIATION';
    if (!paidPeriod) return 'PAID_PERIOD_PROOF_REQUIRED';
    // A capture banked into a wallet is not proof that the paid week advanced.
    // Require the immutable success event for this exact original paid period.
    if (!await db.billingEvent.findFirst({ where: { ...linked, type: 'CHARGE_SUCCESS', amount: paidPeriod.amount,
      idempotencyKey: `success:${s.id}:${s.currentPeriodStart.toISOString().slice(0, 10)}` }, select: { id: true } })) return 'PAID_PERIOD_PROOF_REQUIRED';
    const observations = await db.$queryRaw<Array<{ unresolved: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM card_observations o
        WHERE (o."subscriptionId"=${s.id} OR o."sessionId" IN (SELECT id FROM card_sessions WHERE "subscriptionId"=${s.id})
          OR o."instrumentId" IN (SELECT id FROM payment_instruments WHERE "subscriptionId"=${s.id})
          OR o."paymentId" IN (SELECT id FROM subscription_payments WHERE "subscriptionId"=${s.id}))
        AND o.source <> 'RETURN' AND (o."parsedStatus" NOT IN ('SUCCEEDED','FAILED') OR o.verdict <> 'ACCEPTED'
          OR (o."parsedStatus"='SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM subscription_payments p WHERE p.id=o."paymentId" AND p."subscriptionId"=${s.id} AND p.status='CAPTURED')))
        UNION ALL
        SELECT 1 FROM provider_payments p
        WHERE (p."subscriptionId"=${s.id} OR p.id IN (SELECT a."providerPaymentId" FROM mmg_agent_payments a
          WHERE a."subscriptionId"=${s.id} OR (${s.san}::text IS NOT NULL AND regexp_replace(a."sanRaw",'[^0-9]','','g')=${s.san})))
        AND p.status <> 'CREDITED'
      ) AS unresolved
    `;
    if (observations[0]?.unresolved) return 'SOURCE_OBLIGATIONS_REQUIRE_RECONCILIATION';
    if (s.san) {
      const rows = await db.$queryRaw<Array<{ pending: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM settlement_imports i, jsonb_array_elements(i.rows) r
          WHERE i.status <> 'PUBLISHED' AND regexp_replace(r->>'sanRaw','[^0-9]','','g')=${s.san}
          UNION ALL
          SELECT 1 FROM mmg_agent_payments a WHERE regexp_replace(a."sanRaw",'[^0-9]','','g')=${s.san}
          AND a.status NOT IN ('MATCHED','RESOLVED','RECONCILED')
        ) AS pending
      `;
      if (rows[0]?.pending) return 'INBOUND_SOURCE_PAYMENT_UNRESOLVED';
    }
  }
  return null;
}
