-- [PT-4 · review S2-2] A card payment the provider may have taken but Swift
-- cannot book (an approval without its own proof, an amount or identity that
-- does not match, a lost answer) is never left silent. The session records
-- the provider's transaction reference, a DURABLE claim on the one void Swift
-- sends, and — when the void cannot be confirmed — the finance decision a
-- second person approved: book it, refund it, or nothing was taken. A
-- decision to book is claimed (bookClaimedAt) before the week is booked, so a
-- refund or a "nothing taken" can never run beside it.
-- Each marker only moves forward; nothing here is ever cleared.
ALTER TABLE "card_sessions"
  ADD COLUMN "providerTransactionRef" TEXT,
  ADD COLUMN "providerVoidState" TEXT,
  ADD COLUMN "providerVoidAt" TIMESTAMP(3),
  ADD COLUMN "providerRefundState" TEXT,
  ADD COLUMN "providerRefundAt" TIMESTAMP(3),
  ADD COLUMN "bookClaimedAt" TIMESTAMP(3),
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "resolvedBy" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3);

ALTER TABLE "card_sessions"
  ADD CONSTRAINT "card_sessions_provider_ref_check"
    CHECK ("providerTransactionRef" IS NULL OR char_length("providerTransactionRef") BETWEEN 1 AND 64),
  ADD CONSTRAINT "card_sessions_void_state_check"
    CHECK ("providerVoidState" IS NULL OR "providerVoidState" IN ('SENDING', 'VOIDED', 'FAILED', 'UNKNOWN')),
  ADD CONSTRAINT "card_sessions_refund_state_check"
    CHECK ("providerRefundState" IS NULL OR "providerRefundState" IN ('SENDING', 'PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN')),
  ADD CONSTRAINT "card_sessions_resolution_check"
    CHECK ("resolution" IS NULL OR ("resolution" IN ('BOOKED', 'REFUNDED', 'NOTHING_TAKEN') AND "resolvedBy" IS NOT NULL AND "resolvedAt" IS NOT NULL)),
  ADD CONSTRAINT "card_sessions_void_needs_ref_check"
    CHECK ("providerVoidState" IS NULL OR "providerTransactionRef" IS NOT NULL),
  ADD CONSTRAINT "card_sessions_refund_needs_ref_check"
    CHECK ("providerRefundState" IS NULL OR "providerTransactionRef" IS NOT NULL);

-- Forward only: the reference is written once; a void claim goes
-- NULL -> SENDING -> one answer; a refund claim NULL -> SENDING -> PENDING ->
-- one answer; a booking claim and a resolution are each written once.
CREATE OR REPLACE FUNCTION card_sessions_provider_actions() RETURNS trigger AS $$
BEGIN
  IF OLD."providerTransactionRef" IS NOT NULL AND NEW."providerTransactionRef" IS DISTINCT FROM OLD."providerTransactionRef" THEN
    RAISE EXCEPTION 'card_sessions row %: the provider transaction reference is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerVoidState" IS DISTINCT FROM OLD."providerVoidState" AND NOT (
       (OLD."providerVoidState" IS NULL AND NEW."providerVoidState" = 'SENDING')
    OR (OLD."providerVoidState" = 'SENDING' AND NEW."providerVoidState" IN ('VOIDED', 'FAILED', 'UNKNOWN'))
  ) THEN
    RAISE EXCEPTION 'card_sessions row %: a void claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerVoidState", NEW."providerVoidState" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerRefundState" IS DISTINCT FROM OLD."providerRefundState" AND NOT (
       (OLD."providerRefundState" IS NULL AND NEW."providerRefundState" = 'SENDING')
    OR (OLD."providerRefundState" IN ('SENDING', 'PENDING') AND NEW."providerRefundState" IN ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN'))
  ) THEN
    RAISE EXCEPTION 'card_sessions row %: a refund claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerRefundState", NEW."providerRefundState" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."bookClaimedAt" IS NOT NULL AND NEW."bookClaimedAt" IS DISTINCT FROM OLD."bookClaimedAt" THEN
    RAISE EXCEPTION 'card_sessions row %: a booking claim is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [Review S2-2 · one money movement] A session whose money a void or a
  -- refund may have returned is never booked; a session with a payment is
  -- never voided; a booked payment is never refunded here. (A void or refund
  -- the provider REFUSED moved nothing, so it does not count.)
  IF OLD."providerVoidState" IS NULL AND NEW."providerVoidState" IS NOT NULL AND NEW."paymentId" IS NOT NULL THEN
    RAISE EXCEPTION 'card_sessions row %: a session with a payment is never voided [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."paymentId" IS NULL AND NEW."paymentId" IS NOT NULL
     AND NEW."providerVoidState" IS NOT NULL AND NEW."providerVoidState" <> 'FAILED' THEN
    RAISE EXCEPTION 'card_sessions row %: a session whose void may have taken effect never takes a payment [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF ((OLD."bookClaimedAt" IS NULL AND NEW."bookClaimedAt" IS NOT NULL) OR (OLD."status" <> 'SUCCEEDED' AND NEW."status" = 'SUCCEEDED'))
     AND ((NEW."providerVoidState" IS NOT NULL AND NEW."providerVoidState" <> 'FAILED')
       OR (NEW."providerRefundState" IS NOT NULL AND NEW."providerRefundState" <> 'FAILED')) THEN
    RAISE EXCEPTION 'card_sessions row %: a payment a void or refund may have returned is never booked [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."providerRefundState" IS NULL AND NEW."providerRefundState" IS NOT NULL
     AND (OLD."status" = 'SUCCEEDED'
       OR EXISTS (SELECT 1 FROM "subscription_payments" p WHERE p."id" = NEW."paymentId" AND p."status" = 'CAPTURED')
       OR EXISTS (SELECT 1 FROM "billing_events" e WHERE e."idempotencyKey" = 'bank:' || NEW."paymentId")) THEN
    RAISE EXCEPTION 'card_sessions row %: a booked payment is never refunded here [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."resolution" IS NOT NULL AND (NEW."resolution" IS DISTINCT FROM OLD."resolution"
       OR NEW."resolvedBy" IS DISTINCT FROM OLD."resolvedBy" OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt") THEN
    RAISE EXCEPTION 'card_sessions row %: a finance resolution is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS card_sessions_provider_actions ON card_sessions;
CREATE TRIGGER card_sessions_provider_actions BEFORE UPDATE ON card_sessions FOR EACH ROW EXECUTE FUNCTION card_sessions_provider_actions();
