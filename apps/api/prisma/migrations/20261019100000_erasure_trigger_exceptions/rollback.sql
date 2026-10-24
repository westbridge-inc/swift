-- Rollback of the account erasure's trigger exceptions: the three functions return to their earlier bodies
-- (card_rail_v2, mmg_payer_evidence, evidence_vault), and the helper goes.
-- No data is restored: tokens, keys, hashes and items already forgotten stay forgotten (that is the point).
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION payment_instruments_frozen() RETURNS trigger AS $$
      BEGIN
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

CREATE OR REPLACE FUNCTION payment_instruments_no_delete() RETURNS trigger AS $$
      BEGIN
        IF pg_trigger_depth() > 1 AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE id = OLD."subscriptionId") THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'payment_instruments row % cannot be deleted: a card leaves service through REVOKED or EXPIRED [PT-1]',
          OLD.id USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION safeb_payer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'payer evidence is immutable';
END $$;

CREATE OR REPLACE FUNCTION evidence_item_block_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD."sealedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'evidence item % is sealed — sealed evidence is immutable', OLD."id";
  END IF;
  IF (TG_OP = 'DELETE') THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS swift_erased_person(TEXT);
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261019100000_erasure_trigger_exceptions';
COMMIT;
