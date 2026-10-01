-- SAFE-B: additive evidence; populated rollback must refuse evidence loss.
CREATE TABLE "mmg_payer_evidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "payerHash" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "providerPaymentId" TEXT,
  "paymentId" TEXT,
  "observationId" TEXT,
  "providerContract" TEXT,
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "digest" TEXT NOT NULL UNIQUE
);
CREATE INDEX "mmg_payer_evidence_tenantId_accountId_idx" ON "mmg_payer_evidence" ("tenantId", "accountId");
CREATE INDEX "mmg_payer_evidence_payerHash_idx" ON "mmg_payer_evidence" ("payerHash");
ALTER TABLE "mmg_payer_evidence" ADD CONSTRAINT "mmg_payer_evidence_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE "mmg_payer_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mmg_payer_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mmg_payer_evidence"
 USING (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
 WITH CHECK (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

CREATE TABLE "identity_review_cases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "clusterId" TEXT NOT NULL,
  "snapshotDigest" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "complete" BOOLEAN NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedBy" TEXT,
  "disposition" TEXT,
  "reviewNote" TEXT
);
CREATE UNIQUE INDEX "identity_review_cases_clusterId_snapshotDigest_idx" ON "identity_review_cases" ("clusterId", "snapshotDigest");
CREATE INDEX "identity_review_cases_tenantId_status_idx" ON "identity_review_cases" ("tenantId", "status");
ALTER TABLE "identity_review_cases" ADD CONSTRAINT "identity_review_cases_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE "identity_review_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity_review_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "identity_review_cases"
 USING (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
 WITH CHECK (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE identity_keys ADD COLUMN "mmgEvidenceId" TEXT UNIQUE;
ALTER TABLE identity_keys ADD CONSTRAINT identity_payer_evidence_fk FOREIGN KEY ("mmgEvidenceId") REFERENCES mmg_payer_evidence(id) ON DELETE RESTRICT;
ALTER TABLE identity_clusters ADD COLUMN "authorityReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE identity_review_cases ADD CONSTRAINT review_cluster_fk FOREIGN KEY ("clusterId") REFERENCES identity_clusters(id) ON DELETE RESTRICT;
ALTER TABLE mmg_payer_evidence ADD CONSTRAINT payer_account_fk FOREIGN KEY ("accountId") REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE mmg_payer_evidence ADD CONSTRAINT payer_subscription_fk FOREIGN KEY ("subscriptionId") REFERENCES subscriptions(id) ON DELETE RESTRICT;
-- No current adapter has a reviewed authenticated settled-payer contract.
-- Extending this set requires a provider-contract migration, not a caller flag.
ALTER TABLE mmg_payer_evidence ADD CONSTRAINT payer_tier CHECK (tier IN ('DECLARED','OBSERVED_UNVERIFIED','LEGACY_UNVERIFIED'));
ALTER TABLE mmg_payer_evidence ADD CONSTRAINT payer_unverified CHECK ("providerContract" IS NULL AND "settledAt" IS NULL AND "providerPaymentId" IS NULL AND "paymentId" IS NULL);
ALTER TABLE identity_review_cases ADD CONSTRAINT review_status CHECK (status IN ('OPEN','RETAINED') AND (disposition IS NULL OR disposition = 'KEEP_REVIEW'));
CREATE FUNCTION safeb_payer_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM users WHERE id=NEW."accountId" AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'payer account lineage mismatch'; END IF;
 IF NEW."subscriptionId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subscriptions s LEFT JOIN riders r ON r.id=s."riderId" LEFT JOIN drivers d ON d.id=s."driverId"
   LEFT JOIN vendors v ON v.id=s."vendorId" LEFT JOIN vendor_owners vo ON vo.id=v."ownerId"
   WHERE s.id=NEW."subscriptionId" AND NEW."accountId"=COALESCE(r."userId",d."userId",vo."userId")
 ) THEN RAISE EXCEPTION 'payer subscription mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_payer_lineage BEFORE INSERT ON mmg_payer_evidence FOR EACH ROW EXECUTE FUNCTION safeb_payer_lineage();
CREATE FUNCTION safeb_payer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'payer evidence is immutable';
END $$;
CREATE TRIGGER safeb_payer_immutable BEFORE UPDATE OR DELETE ON mmg_payer_evidence FOR EACH ROW EXECUTE FUNCTION safeb_payer_immutable();
-- Preserve legacy keys, unions, grants and enforcement. Quarantine authority,
-- including transitive members already repointed into the affected root.
UPDATE identity_clusters c SET "authorityReviewRequired"=true
 WHERE EXISTS (SELECT 1 FROM identity_cluster_members m JOIN identity_keys k ON k."accountId"=m."accountId"
  WHERE m."clusterId"=c.id AND k.type='MMG_PAYER');
CREATE FUNCTION safeb_no_unproven_payer_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.type='MMG_PAYER' THEN RAISE EXCEPTION 'no supported settled payer contract'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_no_unproven_payer_key BEFORE INSERT ON identity_keys FOR EACH ROW EXECUTE FUNCTION safeb_no_unproven_payer_key();
-- Historical MMG union provenance can outlive a key (for example after lawful
-- account erasure). Keep that history quarantined too.
UPDATE identity_clusters c SET "authorityReviewRequired"=true WHERE EXISTS (
 SELECT 1 FROM identity_cluster_members m WHERE m."clusterId"=c.id
 AND m."linkedVia"::text LIKE '%MMG_PAYER%'
);
CREATE TRIGGER safeb_no_promoted_payer_key BEFORE UPDATE OF type, "mmgEvidenceId" ON identity_keys
 FOR EACH ROW EXECUTE FUNCTION safeb_no_unproven_payer_key();
CREATE FUNCTION safeb_review_case_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'identity review history is retained'; END IF;
 IF (to_jsonb(NEW) - 'status' - 'reviewedAt' - 'reviewedBy' - 'disposition' - 'reviewNote')
   IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reviewedAt' - 'reviewedBy' - 'disposition' - 'reviewNote')
   OR OLD.status <> 'OPEN' OR NEW.status <> 'RETAINED' OR NEW.disposition <> 'KEEP_REVIEW'
   OR NEW."reviewedAt" IS NULL OR NEW."reviewedBy" IS NULL OR length(coalesce(NEW."reviewNote",'')) < 8 THEN
   RAISE EXCEPTION 'identity review requires an immutable snapshot and explicit retained disposition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_review_case_immutable BEFORE UPDATE OR DELETE ON identity_review_cases FOR EACH ROW EXECUTE FUNCTION safeb_review_case_immutable();
CREATE FUNCTION safeb_identity_authority_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('identity-authority-v1',0));
 RETURN NULL;
END $$;
CREATE TRIGGER safeb_cluster_authority_lock BEFORE UPDATE ON identity_clusters FOR EACH STATEMENT EXECUTE FUNCTION safeb_identity_authority_lock();
CREATE FUNCTION safeb_cluster_review_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."authorityReviewRequired" AND (NOT NEW."authorityReviewRequired" OR NEW."mergedIntoId" IS DISTINCT FROM OLD."mergedIntoId") THEN
  RAISE EXCEPTION 'unresolved identity authority cannot be cleared or merged';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_cluster_review_monotonic BEFORE UPDATE ON identity_clusters FOR EACH ROW EXECUTE FUNCTION safeb_cluster_review_monotonic();
CREATE FUNCTION safeb_new_identity_benefit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root TEXT; flagged BOOLEAN; nextroot TEXT; hops INTEGER;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('identity-authority-v1',0));
 root := NEW."clusterId";
 FOR hops IN 1..32 LOOP
  SELECT "authorityReviewRequired", "mergedIntoId" INTO flagged,nextroot FROM identity_clusters WHERE id=root;
  IF NOT FOUND OR flagged THEN RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED'; END IF;
  IF nextroot IS NULL THEN RETURN NEW; END IF;
  root := nextroot;
 END LOOP;
 RAISE EXCEPTION 'IDENTITY_REVIEW_REQUIRED';
END $$;
CREATE TRIGGER safeb_trial_authority BEFORE INSERT ON trial_grants FOR EACH ROW EXECUTE FUNCTION safeb_new_identity_benefit();
CREATE TRIGGER safeb_exception_authority BEFORE INSERT ON exception_grants FOR EACH ROW EXECUTE FUNCTION safeb_new_identity_benefit();
GRANT SELECT, INSERT, UPDATE ON mmg_payer_evidence, identity_review_cases TO swift_app;

CREATE FUNCTION safeb_review_case_lineage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM identity_clusters c JOIN identity_cluster_members m ON m."clusterId"=c.id
  JOIN users u ON u.id=m."accountId" WHERE c.id=NEW."clusterId" AND c."authorityReviewRequired"
  AND c."mergedIntoId" IS NULL AND u."tenantId"=NEW."tenantId") THEN
  RAISE EXCEPTION 'identity review parent lineage mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_review_case_lineage BEFORE INSERT ON identity_review_cases FOR EACH ROW EXECUTE FUNCTION safeb_review_case_lineage();
