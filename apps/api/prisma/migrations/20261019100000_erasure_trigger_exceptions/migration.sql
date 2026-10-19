-- [GUARDRAILS §2 · owner 19 Oct (G1, G3) · COORD 19 Oct 03:46Z + 04:51Z] The account erasure's one-way
-- exceptions to three immutability triggers. Each applies ONLY to a person whose users row carries the
-- erasure's own marker (phone = 'deleted:' || id). Only the erasure writes that marker, under the users row
-- lock, after it closes authority. Everything else stays exactly as immutable as before.
--   1. payment_instruments: an out-of-service card of an erased person may have its sealed token and wrapped key
--      overwritten with fixed zero bytes (crypto-forgotten) and its card facts replaced by fixed erased values,
--      once. A card erased that way that no payment, card session, observation or replacement names may be deleted.
--   2. mmg_payer_evidence: an erased person's payer hash and digest may be replaced by fixed erased values;
--      nothing else changes, and DELETE stays refused.
--   3. EvidenceItem: a SEALED item may be deleted when its bundle is about an erased person and is not under a
--      legal hold. The app deletes only the items of a closed case or SOS, under the person's and the bundle's
--      locks. The bundle row, its seal hash and its dates stay as proof the evidence existed.

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION swift_erased_person(p_user TEXT) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user AND u.phone = 'deleted:' || u.id);
$$ LANGUAGE sql STABLE;

-- 1a. The frozen-card law, plus the one erasure write.
CREATE OR REPLACE FUNCTION payment_instruments_frozen() RETURNS trigger AS $$
      BEGIN
        -- [erasure] An out-of-service card of an erased person: token and key overwritten, card facts erased,
        -- binding, consent and every exit fact unchanged. Written once (an erased card matches its own values).
        IF OLD."status" <> 'ACTIVE' AND NEW."status" = OLD."status"
           AND NEW."vaultTokenSealed" = decode(repeat('00', 29), 'hex')
           AND NEW."vaultTokenDek" = decode(repeat('00', 33), 'hex')
           AND NEW."brand" = 'ERASED' AND NEW."last4" = '0000' AND NEW."expMonth" = 1 AND NEW."expYear" = 2000
           AND NEW."id" = OLD."id" AND NEW."tenantId" = OLD."tenantId" AND NEW."subscriptionId" = OLD."subscriptionId"
           AND NEW."userId" = OLD."userId" AND NEW."provider" = OLD."provider" AND NEW."environment" = OLD."environment"
           AND NEW."providerAccount" = OLD."providerAccount" AND NEW."consentVersion" = OLD."consentVersion"
           AND NEW."consentAt" = OLD."consentAt" AND NEW."createdAt" = OLD."createdAt"
           AND NEW."replacedAt" IS NOT DISTINCT FROM OLD."replacedAt" AND NEW."replacedById" IS NOT DISTINCT FROM OLD."replacedById"
           AND NEW."revokedAt" IS NOT DISTINCT FROM OLD."revokedAt" AND NEW."revokedBy" IS NOT DISTINCT FROM OLD."revokedBy"
           AND NEW."expiredAt" IS NOT DISTINCT FROM OLD."expiredAt"
           AND swift_erased_person(OLD."userId") THEN
          RETURN NEW;
        END IF;
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
           OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
           OR NEW."userId" IS DISTINCT FROM OLD."userId"
           OR NEW."provider" IS DISTINCT FROM OLD."provider"
           OR NEW."environment" IS DISTINCT FROM OLD."environment"
           OR NEW."providerAccount" IS DISTINCT FROM OLD."providerAccount"
           OR NEW."vaultTokenSealed" IS DISTINCT FROM OLD."vaultTokenSealed"
           OR NEW."vaultTokenDek" IS DISTINCT FROM OLD."vaultTokenDek"
           OR NEW."brand" IS DISTINCT FROM OLD."brand"
           OR NEW."last4" IS DISTINCT FROM OLD."last4"
           OR NEW."expMonth" IS DISTINCT FROM OLD."expMonth"
           OR NEW."expYear" IS DISTINCT FROM OLD."expYear"
           OR NEW."consentVersion" IS DISTINCT FROM OLD."consentVersion"
           OR NEW."consentAt" IS DISTINCT FROM OLD."consentAt"
           OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
          RAISE EXCEPTION 'payment_instruments row % is frozen: its binding, token and card facts never change once written [PT-1 C2]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF (OLD."replacedAt" IS NOT NULL AND NEW."replacedAt" IS DISTINCT FROM OLD."replacedAt")
           OR (OLD."replacedById" IS NOT NULL AND NEW."replacedById" IS DISTINCT FROM OLD."replacedById")
           OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
           OR (OLD."revokedBy" IS NOT NULL AND NEW."revokedBy" IS DISTINCT FROM OLD."revokedBy")
           OR (OLD."expiredAt" IS NOT NULL AND NEW."expiredAt" IS DISTINCT FROM OLD."expiredAt") THEN
          RAISE EXCEPTION 'payment_instruments row %: how it left service is written once and never rewritten [PT-1]',
            OLD.id USING ERRCODE = 'check_violation';
        END IF;
        IF OLD."status" <> 'ACTIVE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
          RAISE EXCEPTION 'payment_instruments row % is %: a terminal instrument never changes status [PT-1]',
            OLD.id, OLD."status" USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;

-- 1b. A card leaves service through REVOKED or EXPIRED, never by DELETE, with two exceptions: the cascade of
-- its own subscription's deletion, and an erased person's erased card that nothing names.
CREATE OR REPLACE FUNCTION payment_instruments_no_delete() RETURNS trigger AS $$
      BEGIN
        IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE id = OLD."subscriptionId") THEN
          RETURN OLD;
        END IF;
        IF OLD."status" <> 'ACTIVE' AND OLD."brand" = 'ERASED'
           AND OLD."vaultTokenSealed" = decode(repeat('00', 29), 'hex') AND OLD."vaultTokenDek" = decode(repeat('00', 33), 'hex')
           AND swift_erased_person(OLD."userId")
           AND NOT EXISTS (SELECT 1 FROM subscription_payments p WHERE p."instrumentId" = OLD.id)
           AND NOT EXISTS (SELECT 1 FROM card_sessions s WHERE s."instrumentId" = OLD.id)
           AND NOT EXISTS (SELECT 1 FROM card_observations o WHERE o."instrumentId" = OLD.id)
           AND NOT EXISTS (SELECT 1 FROM payment_instruments r WHERE r."replacedById" = OLD.id) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'payment_instruments row % cannot be deleted: a card leaves service through REVOKED or EXPIRED [PT-1]',
          OLD.id USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql;

-- 2. Payer evidence stays immutable, except the erasure's one write of an erased person's hash and digest.
CREATE OR REPLACE FUNCTION safeb_payer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'UPDATE' AND NEW."payerHash" = 'erased' AND NEW."digest" = 'erased:' || OLD.id
    AND NEW.id = OLD.id AND NEW."tenantId" = OLD."tenantId" AND NEW."accountId" = OLD."accountId" AND NEW."actorRole" = OLD."actorRole"
    AND NEW.tier = OLD.tier AND NEW.source = OLD.source AND NEW."subscriptionId" IS NOT DISTINCT FROM OLD."subscriptionId"
    AND NEW."providerPaymentId" IS NOT DISTINCT FROM OLD."providerPaymentId" AND NEW."paymentId" IS NOT DISTINCT FROM OLD."paymentId"
    AND NEW."observationId" IS NOT DISTINCT FROM OLD."observationId" AND NEW."providerContract" IS NOT DISTINCT FROM OLD."providerContract"
    AND NEW."settledAt" IS NOT DISTINCT FROM OLD."settledAt" AND NEW."createdAt" = OLD."createdAt"
    AND swift_erased_person(OLD."accountId") THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'payer evidence is immutable';
END $$;

-- 3. Sealed evidence stays immutable, except the erasure's delete of a sealed item whose bundle is about an
-- erased person and under no legal hold.
CREATE OR REPLACE FUNCTION evidence_item_block_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD."sealedAt" IS NOT NULL THEN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1 FROM "EvidenceBundle" b
      WHERE b."id" = OLD."bundleId" AND NOT b."legalHold" AND b."subjectUserId" IS NOT NULL AND swift_erased_person(b."subjectUserId")
        -- Its case (if any) is CLOSED and under no hold; its SOS (if any) is over; no hold covers the bundle or the person.
        AND (b."caseId" IS NULL OR EXISTS (SELECT 1 FROM "IncidentCase" c WHERE c."id" = b."caseId" AND c."status"::text = 'CLOSED' AND NOT c."legalHold"))
        AND (b."sosAlertId" IS NULL OR EXISTS (SELECT 1 FROM "SosAlert" a WHERE a."id" = b."sosAlertId" AND a."status"::text IN ('RESOLVED', 'CANCELLED')))
        AND NOT EXISTS (SELECT 1 FROM legal_holds l WHERE l."bundleId" = b."id" OR l."caseId" = b."caseId")
        AND NOT EXISTS (SELECT 1 FROM safety_deletion_holds h WHERE h."userId" = b."subjectUserId" AND h."status"::text = 'PENDING')
        AND NOT EXISTS (SELECT 1 FROM doc_legal_hold d WHERE d."subjectUserId" = b."subjectUserId" AND d."releasedAt" IS NULL)
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'evidence item % is sealed — sealed evidence is immutable', OLD."id";
  END IF;
  IF (TG_OP = 'DELETE') THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
