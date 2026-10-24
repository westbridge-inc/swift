-- deploy/wall/fixture-fees.sql: the journey roster fixture fees, reset on the throwaway COPY of staging.
--
-- Run ONLY by deploy/wall/journeys-on-copy.sh, ONLY against the rehearsal copy, and only after the
-- script proved the target is the copy: a different cluster from the live one, with identity staging.
-- The statement also refuses by itself on any database whose deployment identity is not staging.
--
-- Why: the journey roster partners (+5920 fictional numbers: JOURNEY_VENDORS and JOURNEY_MOVERS in
-- scripts/livetest/roster.ts) live on staging for weeks. Their 14-day trials end, and billing then
-- suspends them for an unpaid weekly fee, correctly (16 Oct: every one SUSPENDED since 11 Oct). On the
-- copy, the walled journeys then cannot take an order or put a mover online.
--
-- What, on the copy only, for those 12 partners only:
--   * each weekly fee gets the state a NEW partner is born with (SubscriptionService activation in
--     modules/subscription/subscription.service.ts: TRIAL, trial and period end = now + 14 days), with
--     the dunning fields a new row has (no grace, no retry, no failed attempt, not suspended);
--   * a store that BILLING suspended gets back exactly what billing took (restoreBillingAccess in
--     modules/billing/billing-access.ts). A store suspended for any other reason stays suspended.
-- Nothing else: no payment, receipt, billing event, obligation, ledger, MMG, clock or audit row is
-- written, and nothing is deleted. Movers need no row change: go-online sets them online.
--
-- Prints one line, counts only: "<fees reset> <stores reopened>".
WITH roster AS (
  SELECT u.id
    FROM users u
   WHERE u.phone IN (
           '+5920402011', '+5920402012', '+5920402013', '+5920402021', '+5920402031',
           '+5920403051', '+5920403052', '+5920403053', '+5920403054',
           '+5920403061', '+5920403062', '+5920403063')
     AND u.phone LIKE '+5920%'
     AND (SELECT d.environment FROM deployment_identity d WHERE d.id = 'singleton') = 'staging'
), fees AS (
  SELECT s.id
    FROM subscriptions s
    LEFT JOIN riders r ON r.id = s."riderId"
    LEFT JOIN drivers dr ON dr.id = s."driverId"
    LEFT JOIN vendors v ON v.id = s."vendorId"
    LEFT JOIN vendor_owners vo ON vo.id = v."ownerId"
   WHERE COALESCE(r."userId", dr."userId", vo."userId") IN (SELECT id FROM roster)
), reset AS (
  UPDATE subscriptions
     SET status = 'TRIAL',
         "isTrialActive" = true,
         "currentPeriodStart" = now(),
         "trialEndDate" = now() + interval '14 days',
         "currentPeriodEnd" = now() + interval '14 days',
         "nextBillingDate" = now() + interval '14 days',
         "isInGracePeriod" = false,
         "gracePeriodEnd" = NULL,
         "failedAttempts" = 0,
         "nextRetryAt" = NULL,
         "suspendedAt" = NULL,
         "billingEnforcementDueAt" = NULL,
         "updatedAt" = now()
   WHERE id IN (SELECT id FROM fees)
  RETURNING "vendorId"
), stores AS (
  UPDATE vendors
     SET status = 'ACTIVE',
         "suspensionSource" = NULL,
         "acceptingOrders" = ("acceptingOrders" OR "isVerified"),
         "updatedAt" = now()
   WHERE id IN (SELECT "vendorId" FROM reset WHERE "vendorId" IS NOT NULL)
     AND status = 'SUSPENDED'
     AND "suspensionSource" = 'BILLING'
  RETURNING id
)
SELECT (SELECT count(*) FROM reset)::text || ' ' || (SELECT count(*) FROM stores)::text AS touched;
