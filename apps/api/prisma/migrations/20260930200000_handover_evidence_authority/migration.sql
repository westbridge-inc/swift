-- SAFE-B: additive evidence; populated rollback must refuse evidence loss.
CREATE TABLE "handover_photo_proofs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "riderId" TEXT,
  "driverId" TEXT,
  "purpose" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL UNIQUE,
  "contentHash" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "bindingDigest" TEXT NOT NULL,
  "sourceStatus" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3),
  "invalidationReason" TEXT
);
CREATE INDEX "handover_photo_proofs_tenantId_orderId_idx" ON "handover_photo_proofs" ("tenantId", "orderId");
ALTER TABLE "handover_photo_proofs" ADD CONSTRAINT "handover_photo_proofs_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE "handover_photo_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "handover_photo_proofs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "handover_photo_proofs"
 USING (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
 WITH CHECK (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));

CREATE TABLE "cash_handover_evidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL UNIQUE,
  "customerId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "riderId" TEXT,
  "driverId" TEXT,
  "orderType" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "sourceStatus" TEXT NOT NULL,
  "bindingDigest" TEXT NOT NULL,
  "filedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locationLat" DOUBLE PRECISION,
  "locationLng" DOUBLE PRECISION,
  "locationAt" TIMESTAMP(3),
  "locationSessionId" TEXT,
  "actorSessionId" TEXT,
  "declaredLat" DOUBLE PRECISION NOT NULL,
  "declaredLng" DOUBLE PRECISION NOT NULL,
  "arrivalLogId" TEXT,
  "arrivalAt" TIMESTAMP(3),
  "waitedMs" DOUBLE PRECISION,
  "photoProofId" TEXT UNIQUE,
  "policyVersion" TEXT NOT NULL,
  "maxDistanceKm" DOUBLE PRECISION NOT NULL,
  "maxLocationAgeMs" INTEGER NOT NULL,
  "invalidatedAt" TIMESTAMP(3),
  "invalidationReason" TEXT
);
CREATE INDEX "cash_handover_evidence_tenantId_orderId_idx" ON "cash_handover_evidence" ("tenantId", "orderId");
ALTER TABLE "cash_handover_evidence" ADD CONSTRAINT "cash_handover_evidence_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE "cash_handover_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_handover_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cash_handover_evidence"
 USING (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
 WITH CHECK (("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
ALTER TABLE reimbursement_claims ADD COLUMN "handoverEvidenceId" TEXT UNIQUE;
ALTER TABLE reimbursement_claims ADD CONSTRAINT claim_handover_evidence_fk FOREIGN KEY ("handoverEvidenceId") REFERENCES cash_handover_evidence(id) ON DELETE RESTRICT;
ALTER TABLE cash_handover_evidence ADD CONSTRAINT handover_photo_fk FOREIGN KEY ("photoProofId") REFERENCES handover_photo_proofs(id) ON DELETE RESTRICT;
ALTER TABLE cash_handover_evidence ADD CONSTRAINT handover_arrival_fk FOREIGN KEY ("arrivalLogId") REFERENCES order_status_logs(id) ON DELETE RESTRICT;
ALTER TABLE handover_photo_proofs ADD CONSTRAINT photo_order_fk FOREIGN KEY ("orderId") REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE cash_handover_evidence ADD CONSTRAINT evidence_order_fk FOREIGN KEY ("orderId") REFERENCES orders(id) ON DELETE RESTRICT;
ALTER TABLE handover_photo_proofs ADD CONSTRAINT photo_mover CHECK (("riderId" IS NULL) <> ("driverId" IS NULL));
ALTER TABLE cash_handover_evidence ADD CONSTRAINT evidence_mover CHECK (("riderId" IS NULL) <> ("driverId" IS NULL));
ALTER TABLE handover_photo_proofs ADD CONSTRAINT photo_shape CHECK (purpose = 'HANDOVER' AND "byteSize" BETWEEN 12 AND 10485760 AND "contentHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE cash_handover_evidence ADD CONSTRAINT evidence_shape CHECK (outcome IN ('no_show','refused') AND "maxDistanceKm" > 0 AND "maxDistanceKm" <= 10 AND "maxLocationAgeMs" BETWEEN 0 AND 300000);

CREATE FUNCTION safeb_handover_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE; actor TEXT;
BEGIN
 SELECT * INTO o FROM orders WHERE id = NEW."orderId" FOR SHARE;
 IF NOT FOUND OR o."tenantId" <> NEW."tenantId" OR o."customerId" <> NEW."customerId"
   OR o."riderId" IS DISTINCT FROM NEW."riderId" OR o."driverId" IS DISTINCT FROM NEW."driverId" THEN
   RAISE EXCEPTION 'handover parent lineage mismatch';
 END IF;
 IF NEW."riderId" IS NOT NULL THEN SELECT "userId" INTO actor FROM riders WHERE id=NEW."riderId";
 ELSE SELECT "userId" INTO actor FROM drivers WHERE id=NEW."driverId"; END IF;
 IF actor IS DISTINCT FROM NEW."actorId" THEN RAISE EXCEPTION 'handover actor mismatch'; END IF;
 IF NOT EXISTS (SELECT 1 FROM users WHERE id=actor AND "tenantId"=NEW."tenantId") THEN RAISE EXCEPTION 'handover actor tenant mismatch'; END IF;
 IF TG_TABLE_NAME='cash_handover_evidence' THEN
  IF NEW."orderType" <> o."orderType"::text THEN RAISE EXCEPTION 'handover rail mismatch'; END IF;
  IF NEW."photoProofId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM handover_photo_proofs p
   WHERE p.id=NEW."photoProofId" AND p."orderId"=NEW."orderId" AND p."tenantId"=NEW."tenantId"
   AND p."customerId"=NEW."customerId" AND p."actorId"=NEW."actorId"
   AND p."riderId" IS NOT DISTINCT FROM NEW."riderId" AND p."driverId" IS NOT DISTINCT FROM NEW."driverId"
   AND p."bindingDigest"=NEW."bindingDigest") THEN RAISE EXCEPTION 'handover photo lineage mismatch'; END IF;
  IF NEW."arrivalLogId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM order_status_logs l
   WHERE l.id=NEW."arrivalLogId" AND l."orderId"=NEW."orderId" AND l.status='ARRIVED'
   AND l."createdAt"=NEW."arrivalAt") THEN RAISE EXCEPTION 'handover arrival lineage mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_photo_lineage BEFORE INSERT ON handover_photo_proofs FOR EACH ROW EXECUTE FUNCTION safeb_handover_lineage();
CREATE TRIGGER safeb_evidence_lineage BEFORE INSERT ON cash_handover_evidence FOR EACH ROW EXECUTE FUNCTION safeb_handover_lineage();

-- Only one-way invalidation is mutable. Replacing provenance is not review.
CREATE FUNCTION safeb_immutable_handover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'handover evidence is retained'; END IF;
 IF (to_jsonb(NEW) - 'invalidatedAt' - 'invalidationReason') IS DISTINCT FROM (to_jsonb(OLD) - 'invalidatedAt' - 'invalidationReason')
   OR OLD."invalidatedAt" IS NOT NULL OR NEW."invalidatedAt" IS NULL OR length(coalesce(NEW."invalidationReason",'')) < 8 THEN
   RAISE EXCEPTION 'handover evidence is immutable except reasoned invalidation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_photo_immutable BEFORE UPDATE OR DELETE ON handover_photo_proofs FOR EACH ROW EXECUTE FUNCTION safeb_immutable_handover();
CREATE TRIGGER safeb_evidence_immutable BEFORE UPDATE OR DELETE ON cash_handover_evidence FOR EACH ROW EXECUTE FUNCTION safeb_immutable_handover();
CREATE FUNCTION safeb_claim_evidence_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e cash_handover_evidence%ROWTYPE;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW."handoverEvidenceId" IS DISTINCT FROM OLD."handoverEvidenceId" OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
   OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."riderId" IS DISTINCT FROM OLD."riderId" OR NEW."driverId" IS DISTINCT FROM OLD."driverId"
   OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.amount IS DISTINCT FROM OLD.amount) THEN RAISE EXCEPTION 'claim provenance is immutable'; END IF;
 IF NEW."handoverEvidenceId" IS NOT NULL THEN
  SELECT * INTO e FROM cash_handover_evidence WHERE id=NEW."handoverEvidenceId" FOR SHARE;
  IF NOT FOUND OR e."orderId" <> NEW."orderId" OR e."customerId" <> NEW."customerId" OR e."riderId" IS DISTINCT FROM NEW."riderId"
    OR e."driverId" IS DISTINCT FROM NEW."driverId" OR e.outcome <> NEW.reason THEN RAISE EXCEPTION 'claim evidence mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER safeb_claim_binding BEFORE INSERT OR UPDATE ON reimbursement_claims FOR EACH ROW EXECUTE FUNCTION safeb_claim_evidence_binding();
GRANT SELECT, INSERT, UPDATE ON handover_photo_proofs, cash_handover_evidence TO swift_app;
