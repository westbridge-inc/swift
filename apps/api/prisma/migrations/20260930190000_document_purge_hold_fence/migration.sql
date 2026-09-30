BEGIN;
-- Drain old destructive workers before enabling this fence. A paused old binary
-- cannot be fenced at its external storage boundary by database DDL alone.
ALTER TABLE encrypted_objects ADD COLUMN "sourceId" uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "retiredClaimId" uuid, ADD COLUMN "storageNamespace" text, ADD COLUMN "uploadState" text NOT NULL DEFAULT 'READY';
CREATE UNIQUE INDEX "encrypted_objects_sourceId_key" ON encrypted_objects("sourceId");
CREATE UNIQUE INDEX "encrypted_objects_retiredClaimId_key" ON encrypted_objects("retiredClaimId");
ALTER TABLE verification_documents ADD COLUMN "activePurgeClaimId" uuid,
  ADD COLUMN "imageCompletionClaimId" uuid, ADD COLUMN "fieldsPurgedAt" timestamp(3),
  ADD COLUMN "imageSourceKind" text NOT NULL DEFAULT 'UNPROVEN';
CREATE UNIQUE INDEX "verification_documents_activePurgeClaimId_key" ON verification_documents("activePurgeClaimId");
CREATE TABLE document_purge_claim (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  "userId" text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  "documentId" text REFERENCES verification_documents(id) ON DELETE RESTRICT,
  "orphanId" text REFERENCES storage_orphans(id) ON DELETE RESTRICT,
  "subjectId" uuid, "docType" text, role text,
  mode text NOT NULL CHECK (mode IN ('IMAGE_ONLY','FULL_RETENTION','FULL_ERASURE','UNATTACHED_OBJECT')),
  "sourceKind" text NOT NULL CHECK ("sourceKind" IN ('OBJECT','PRIOR_IMAGE','BORN_EMPTY')),
  "sourceId" uuid REFERENCES encrypted_objects("sourceId") ON DELETE RESTRICT,
  "fileKey" text, "storageNamespace" text, "sourceFingerprint" text, sha256 text, "sizeBytes" integer,
  "previousImageClaimId" uuid REFERENCES document_purge_claim(id) ON DELETE RESTRICT,
  "runIds" uuid[] NOT NULL DEFAULT '{}', "fieldIds" uuid[] NOT NULL DEFAULT '{}',
  "initiatedBy" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimXid" bigint NOT NULL DEFAULT txid_current(),
  state text NOT NULL DEFAULT 'COMMITTED' CHECK (state IN ('COMMITTED','COMPLETE')),
  "completedAt" timestamp(3),
  CHECK ((mode = 'UNATTACHED_OBJECT') = ("orphanId" IS NOT NULL AND "documentId" IS NULL)),
  CHECK ((mode = 'UNATTACHED_OBJECT') OR "documentId" IS NOT NULL),
  CHECK ((state = 'COMPLETE') = ("completedAt" IS NOT NULL)),
  CHECK (("sourceKind" = 'OBJECT') = ("sourceId" IS NOT NULL AND "fileKey" IS NOT NULL AND "storageNamespace" IS NOT NULL AND "sourceFingerprint" IS NOT NULL)),
  CHECK (("sourceKind" = 'PRIOR_IMAGE') = ("previousImageClaimId" IS NOT NULL)),
  CHECK (mode = 'FULL_ERASURE' OR (cardinality("runIds") = 0 AND cardinality("fieldIds") = 0))
);
CREATE UNIQUE INDEX document_purge_claim_source_once ON document_purge_claim("sourceId") WHERE "sourceId" IS NOT NULL;
CREATE UNIQUE INDEX document_purge_claim_active_document ON document_purge_claim("documentId") WHERE state = 'COMMITTED';
CREATE INDEX "document_purge_claim_tenantId_state_createdAt_idx" ON document_purge_claim("tenantId", state, "createdAt");
CREATE INDEX "document_purge_claim_documentId_idx" ON document_purge_claim("documentId");
CREATE INDEX "document_purge_claim_userId_idx" ON document_purge_claim("userId");
ALTER TABLE encrypted_objects ADD CONSTRAINT encrypted_objects_retirement_fk FOREIGN KEY ("retiredClaimId") REFERENCES document_purge_claim(id) ON DELETE RESTRICT;
ALTER TABLE verification_documents ADD CONSTRAINT verification_documents_active_claim_fk FOREIGN KEY ("activePurgeClaimId") REFERENCES document_purge_claim(id) ON DELETE RESTRICT,
  ADD CONSTRAINT verification_documents_image_claim_fk FOREIGN KEY ("imageCompletionClaimId") REFERENCES document_purge_claim(id) ON DELETE RESTRICT;
CREATE TABLE document_purge_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "tenantId" text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  "userId" text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  "claimId" uuid REFERENCES document_purge_claim(id) ON DELETE RESTRICT,
  "holdId" uuid REFERENCES doc_legal_hold(id) ON DELETE RESTRICT,
  kind text NOT NULL, "actorId" text NOT NULL, details jsonb NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "document_purge_event_tenantId_createdAt_idx" ON document_purge_event("tenantId", "createdAt");
CREATE INDEX "document_purge_event_claimId_idx" ON document_purge_event("claimId");
ALTER TABLE deletion_receipt ADD COLUMN "purgeClaimId" uuid REFERENCES document_purge_claim(id) ON DELETE RESTRICT, ADD COLUMN scope text;
CREATE UNIQUE INDEX "deletion_receipt_purgeClaimId_key" ON deletion_receipt("purgeClaimId");

-- These ledgers carry no default tenant: lineage must be explicit.
ALTER TABLE document_purge_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_purge_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_purge_claim USING ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')) WITH CHECK ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'));
CREATE POLICY tenant_isolation ON document_purge_event USING ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')) WITH CHECK ("tenantId" = current_setting('app.current_tenant', true) OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'));

CREATE FUNCTION document_purge_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d verification_documents; o encrypted_objects; u users; prior document_purge_claim; r storage_orphans;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'purge authority is permanent'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'state' - 'completedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'completedAt')
      OR OLD.state <> 'COMMITTED' OR NEW.state <> 'COMPLETE' OR NEW."completedAt" IS NULL
      OR OLD."claimXid" = txid_current() THEN RAISE EXCEPTION 'immutable purge claim'; END IF;
    IF NEW."documentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deletion_receipt WHERE "purgeClaimId" = NEW.id AND "verificationProbeResult" IN ('CONFIRMED_ABSENT','NOT_APPLICABLE')) THEN RAISE EXCEPTION 'purge receipt required'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO u FROM users WHERE id = NEW."userId" FOR UPDATE;
  IF NOT FOUND OR u."tenantId" <> NEW."tenantId" OR NEW.state <> 'COMMITTED' OR NEW."claimXid" <> txid_current() THEN RAISE EXCEPTION 'purge tenant or initial state mismatch'; END IF;
  IF NEW."documentId" IS NOT NULL THEN
    SELECT * INTO d FROM verification_documents WHERE id = NEW."documentId" FOR UPDATE;
    IF NOT FOUND OR d."userId" <> u.id OR d."legalHoldId" IS NOT NULL OR d."activePurgeClaimId" IS NOT NULL
      OR d."subjectId" IS DISTINCT FROM NEW."subjectId" OR d."docType" IS DISTINCT FROM NEW."docType" OR d.role::text IS DISTINCT FROM NEW.role THEN RAISE EXCEPTION 'document purge binding unavailable'; END IF;
    IF NEW."sourceKind" = 'OBJECT' AND d."fileUrl" <> NEW."fileKey" THEN RAISE EXCEPTION 'purge pointer mismatch'; END IF;
    IF NEW."sourceKind" = 'BORN_EMPTY' AND (d."imageSourceKind" <> 'BORN_EMPTY' OR d."fileUrl" <> '') THEN RAISE EXCEPTION 'unproven empty source'; END IF;
    IF NEW."sourceKind" = 'PRIOR_IMAGE' THEN
      SELECT * INTO prior FROM document_purge_claim WHERE id = NEW."previousImageClaimId";
      IF NOT FOUND OR prior.state <> 'COMPLETE' OR prior."documentId" <> d.id OR d."imageCompletionClaimId" <> prior.id OR d."fileUrl" <> '' THEN RAISE EXCEPTION 'image lineage mismatch'; END IF;
    END IF;
    IF NEW.mode = 'FULL_ERASURE' AND (
      NEW."runIds" IS DISTINCT FROM ARRAY(SELECT id FROM extraction_run WHERE "submissionId" = d.id ORDER BY id)
      OR NEW."fieldIds" IS DISTINCT FROM ARRAY(SELECT id FROM extracted_field WHERE "submissionId" = d.id ORDER BY id)
    ) THEN RAISE EXCEPTION 'extraction scope mismatch'; END IF;
  END IF;
  IF NEW."sourceKind" = 'OBJECT' THEN
    SELECT * INTO o FROM encrypted_objects WHERE "sourceId" = NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR o."createdBy" <> u.id OR o."fileKey" <> NEW."fileKey" OR o."retiredClaimId" IS NOT NULL
      OR o."uploadState" <> 'READY' OR o."wrappedDek" IS NULL OR o."shreddedAt" IS NOT NULL OR o.sha256 <> NEW.sha256 OR o."sizeBytes" <> NEW."sizeBytes"
      OR o."storageNamespace" IS DISTINCT FROM NEW."storageNamespace" THEN RAISE EXCEPTION 'purge source mismatch'; END IF;
  END IF;
  IF NEW.mode = 'UNATTACHED_OBJECT' THEN
    SELECT * INTO r FROM storage_orphans WHERE id = NEW."orphanId" FOR UPDATE;
    IF NOT FOUND OR r."userId" IS DISTINCT FROM u.id OR r."tenantId" <> u."tenantId" OR r.key <> NEW."fileKey" OR r."purgedAt" IS NOT NULL
      OR EXISTS (SELECT 1 FROM doc_legal_hold WHERE "subjectUserId" = u.id AND "releasedAt" IS NULL)
      OR EXISTS (SELECT 1 FROM verification_documents WHERE "fileUrl" = r.key) THEN RAISE EXCEPTION 'orphan purge unavailable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_purge_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON document_purge_claim FOR EACH ROW EXECUTE FUNCTION document_purge_claim_guard();

CREATE FUNCTION document_purge_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'purge events are append only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW."userId" AND "tenantId" = NEW."tenantId")
    OR (NEW."claimId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_purge_claim WHERE id = NEW."claimId" AND "userId" = NEW."userId" AND "tenantId" = NEW."tenantId"))
    OR (NEW."holdId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM doc_legal_hold WHERE id = NEW."holdId" AND "subjectUserId" = NEW."userId" AND "tenantId" = NEW."tenantId")) THEN RAISE EXCEPTION 'purge event lineage mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_purge_event_guard BEFORE INSERT OR UPDATE OR DELETE ON document_purge_event FOR EACH ROW EXECUTE FUNCTION document_purge_event_guard();

-- A new writer may only introduce a canonical spelling. Legacy aliases remain
-- readable but cannot be rebound or used to evade a permanent retirement.
CREATE FUNCTION document_source_key_guard(k text, owner_id text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF owner_id !~ '^[A-Za-z0-9_-]+$' OR NOT (k ~ ('^(/uploads/)?verification/' || owner_id || '/[A-Za-z0-9_-]{1,200}\.enc$')) THEN RAISE EXCEPTION 'noncanonical verification source'; END IF;
  IF EXISTS (SELECT 1 FROM document_purge_claim WHERE "sourceKind" = 'OBJECT'
    AND regexp_replace("fileKey", '^/uploads/', '') = regexp_replace(k, '^/uploads/', '')) THEN RAISE EXCEPTION 'permanently retired verification source'; END IF;
END $$;

CREATE FUNCTION document_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c document_purge_claim;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM users WHERE id = NEW."createdBy" AND status NOT IN ('DEACTIVATED','BANNED','SUSPENDED') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source owner unavailable'; END IF;
    PERFORM document_source_key_guard(NEW."fileKey", NEW."createdBy");
    IF NEW."retiredClaimId" IS NOT NULL OR NEW."shreddedAt" IS NOT NULL THEN RAISE EXCEPTION 'new source cannot be retired'; END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM users WHERE id = OLD."createdBy" FOR UPDATE;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'source names are permanent reservations'; END IF;
  IF OLD."storageNamespace" IS NOT NULL AND NEW."storageNamespace" IS DISTINCT FROM OLD."storageNamespace" THEN RAISE EXCEPTION 'storage namespace immutable'; END IF;
  IF OLD."uploadState" = 'READY' AND NEW."uploadState" <> 'READY' THEN RAISE EXCEPTION 'upload state cannot regress'; END IF;
  IF OLD."retiredClaimId" IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'wrappedDek' - 'shreddedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'wrappedDek' - 'shreddedAt') THEN RAISE EXCEPTION 'retired source is immutable'; END IF;
  ELSIF (NEW."fileKey", NEW."createdBy", NEW."sourceId", NEW."createdAt", NEW.sha256, NEW."sizeBytes", NEW."mimeType", NEW.iv, NEW."authTag") IS DISTINCT FROM (OLD."fileKey", OLD."createdBy", OLD."sourceId", OLD."createdAt", OLD.sha256, OLD."sizeBytes", OLD."mimeType", OLD.iv, OLD."authTag") THEN
    RAISE EXCEPTION 'source identity is immutable';
  END IF;
  IF NEW."retiredClaimId" IS NOT NULL THEN
    SELECT * INTO c FROM document_purge_claim WHERE id = NEW."retiredClaimId";
    IF NOT FOUND OR c."sourceId" <> OLD."sourceId" OR c."fileKey" <> OLD."fileKey" OR c."userId" <> OLD."createdBy" THEN RAISE EXCEPTION 'retirement claim mismatch'; END IF;
  END IF;
  IF (NEW."wrappedDek", NEW."shreddedAt") IS DISTINCT FROM (OLD."wrappedDek", OLD."shreddedAt") THEN
    IF c.id IS NULL OR c."claimXid" = txid_current() OR NEW."wrappedDek" IS NOT NULL OR NEW."shreddedAt" IS NULL THEN RAISE EXCEPTION 'committed exact source authority required'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_source_guard BEFORE INSERT OR UPDATE OR DELETE ON encrypted_objects FOR EACH ROW EXECUTE FUNCTION document_source_guard();

CREATE FUNCTION document_hold_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c document_purge_claim; owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."userId" ELSE OLD."userId" END;
  PERFORM 1 FROM users WHERE id = owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document owner unavailable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."activePurgeClaimId" IS NOT NULL OR NEW."imageCompletionClaimId" IS NOT NULL OR NEW."fieldsPurgedAt" IS NOT NULL THEN RAISE EXCEPTION 'new document cannot carry purge authority'; END IF;
    IF NEW."legalHoldId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM doc_legal_hold h JOIN users u ON u.id = h."subjectUserId" AND u."tenantId" = h."tenantId" WHERE h.id = NEW."legalHoldId" AND h."subjectUserId" = owner_id AND h."releasedAt" IS NULL) THEN RAISE EXCEPTION 'new document hold lineage mismatch'; END IF;
    NEW."imageSourceKind" := CASE WHEN NEW."fileUrl" = '' THEN 'BORN_EMPTY' ELSE 'OBJECT' END;
    IF NEW."fileUrl" <> '' THEN PERFORM document_source_key_guard(NEW."fileUrl", owner_id); END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."legalHoldId" IS NOT NULL OR OLD."activePurgeClaimId" IS NOT NULL OR EXISTS (SELECT 1 FROM document_purge_claim WHERE "documentId" = OLD.id) THEN RAISE EXCEPTION 'held or claimed document cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."imageSourceKind" IS DISTINCT FROM OLD."imageSourceKind" THEN RAISE EXCEPTION 'source origin immutable'; END IF;
  IF OLD."legalHoldId" IS NOT NULL AND NEW."legalHoldId" IS DISTINCT FROM OLD."legalHoldId" AND NOT EXISTS (SELECT 1 FROM doc_legal_hold WHERE id = OLD."legalHoldId" AND "releasedAt" IS NOT NULL) THEN RAISE EXCEPTION 'active hold cannot be unstamped'; END IF;
  IF NEW."legalHoldId" IS NOT NULL AND NEW."legalHoldId" IS DISTINCT FROM OLD."legalHoldId" THEN
    IF EXISTS (SELECT 1 FROM document_purge_claim WHERE "userId" = owner_id AND state = 'COMMITTED' AND ("documentId" = OLD.id OR mode = 'UNATTACHED_OBJECT')) THEN RAISE EXCEPTION 'DOCUMENT_PURGE_COMMITTED'; END IF;
    IF NOT EXISTS (SELECT 1 FROM doc_legal_hold h JOIN users u ON u.id = h."subjectUserId" AND u."tenantId" = h."tenantId" WHERE h.id = NEW."legalHoldId" AND h."subjectUserId" = owner_id AND h."releasedAt" IS NULL) THEN RAISE EXCEPTION 'hold lineage mismatch'; END IF;
  END IF;
  IF OLD."legalHoldId" IS NOT NULL OR EXISTS (SELECT 1 FROM document_purge_claim WHERE "documentId" = OLD.id) THEN
    IF (NEW.id, NEW."userId", NEW."subjectId", NEW.role, NEW."docType", NEW."imageSourceKind") IS DISTINCT FROM (OLD.id, OLD."userId", OLD."subjectId", OLD.role, OLD."docType", OLD."imageSourceKind") THEN RAISE EXCEPTION 'held or claimed identity immutable'; END IF;
  END IF;
  IF NEW."activePurgeClaimId" IS NOT NULL THEN
    SELECT * INTO c FROM document_purge_claim WHERE id = NEW."activePurgeClaimId" AND "documentId" = OLD.id AND "userId" = owner_id AND state = 'COMMITTED';
    IF NOT FOUND OR NEW."legalHoldId" IS NOT NULL THEN RAISE EXCEPTION 'document claim pointer mismatch'; END IF;
  ELSE
    SELECT * INTO c FROM document_purge_claim WHERE id = OLD."activePurgeClaimId" AND "documentId" = OLD.id;
  END IF;
  IF (NEW.state = 'PURGED' AND NEW.state IS DISTINCT FROM OLD.state) OR NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl" OR NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt" OR NEW."imagePurgedAt" IS DISTINCT FROM OLD."imagePurgedAt" OR NEW."fieldsPurgedAt" IS DISTINCT FROM OLD."fieldsPurgedAt" OR NEW."imageCompletionClaimId" IS DISTINCT FROM OLD."imageCompletionClaimId" THEN
    IF OLD."legalHoldId" IS NOT NULL OR c.id IS NULL OR c."claimXid" = txid_current() OR NEW."fileUrl" <> '' THEN RAISE EXCEPTION 'committed document authority required'; END IF;
    IF c.mode = 'IMAGE_ONLY' AND (NEW."purgedAt", NEW."fieldsPurgedAt") IS DISTINCT FROM (OLD."purgedAt", OLD."fieldsPurgedAt") THEN RAISE EXCEPTION 'image authority cannot erase fields'; END IF;
    IF NEW."fieldsPurgedAt" IS DISTINCT FROM OLD."fieldsPurgedAt" AND c.mode <> 'FULL_ERASURE' THEN RAISE EXCEPTION 'field erasure authority required'; END IF;
  END IF;
  IF OLD."activePurgeClaimId" IS NOT NULL AND NEW."activePurgeClaimId" IS DISTINCT FROM OLD."activePurgeClaimId" AND (NEW."activePurgeClaimId" IS NOT NULL OR c.state <> 'COMPLETE') THEN RAISE EXCEPTION 'active authority cannot be revoked'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_document_hold_purge_guard BEFORE INSERT OR UPDATE OR DELETE ON verification_documents FOR EACH ROW EXECUTE FUNCTION document_hold_purge_guard();

CREATE FUNCTION document_extraction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d verification_documents; c document_purge_claim; sid text; old_value bytea; new_value bytea;
BEGIN
  sid := CASE WHEN TG_OP = 'INSERT' THEN NEW."submissionId" ELSE OLD."submissionId" END;
  SELECT * INTO d FROM verification_documents WHERE id = sid;
  PERFORM 1 FROM users WHERE id = d."userId" FOR UPDATE;
  SELECT * INTO d FROM verification_documents WHERE id = sid FOR UPDATE;
  SELECT * INTO c FROM document_purge_claim WHERE "documentId" = sid AND mode = 'FULL_ERASURE' LIMIT 1;
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'extracted_field' THEN
    IF NOT EXISTS (SELECT 1 FROM extraction_run WHERE id = (to_jsonb(NEW)->>'runId')::uuid AND "submissionId" = NEW."submissionId" AND "tenantId" = NEW."tenantId") THEN RAISE EXCEPTION 'extracted field run lineage mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF c.id IS NOT NULL THEN RAISE EXCEPTION 'erased extraction scope closed'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF d."legalHoldId" IS NOT NULL OR EXISTS (SELECT 1 FROM document_purge_claim WHERE "documentId" = sid) THEN RAISE EXCEPTION 'held or claimed extraction cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  old_value := CASE WHEN TG_TABLE_NAME = 'extraction_run' THEN decode(substr(to_jsonb(OLD)->>'wrappedDek',3),'hex') ELSE decode(substr(to_jsonb(OLD)->>'valueCt',3),'hex') END;
  new_value := CASE WHEN TG_TABLE_NAME = 'extraction_run' THEN decode(substr(to_jsonb(NEW)->>'wrappedDek',3),'hex') ELSE decode(substr(to_jsonb(NEW)->>'valueCt',3),'hex') END;
  IF (NEW.id, NEW."submissionId", NEW."tenantId") IS DISTINCT FROM (OLD.id, OLD."submissionId", OLD."tenantId") AND (c.id IS NOT NULL OR d."legalHoldId" IS NOT NULL) THEN RAISE EXCEPTION 'extraction identity immutable'; END IF;
  IF (c.id IS NOT NULL OR d."legalHoldId" IS NOT NULL) AND (to_jsonb(NEW) - 'wrappedDek' - 'valueCt') IS DISTINCT FROM (to_jsonb(OLD) - 'wrappedDek' - 'valueCt') THEN RAISE EXCEPTION 'claimed extraction identity immutable'; END IF;
  IF new_value IS DISTINCT FROM old_value THEN
    IF d."legalHoldId" IS NOT NULL THEN RAISE EXCEPTION 'held extraction immutable'; END IF;
    IF c.id IS NOT NULL OR new_value IS NULL THEN
      IF c.id IS NULL OR c."claimXid" = txid_current() OR c.state <> 'COMMITTED' OR new_value IS NOT NULL OR
        (TG_TABLE_NAME = 'extraction_run' AND NOT OLD.id = ANY(c."runIds")) OR
        (TG_TABLE_NAME = 'extracted_field' AND NOT OLD.id = ANY(c."fieldIds")) THEN RAISE EXCEPTION 'committed field scope required'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_extraction_guard BEFORE INSERT OR UPDATE OR DELETE ON extraction_run FOR EACH ROW EXECUTE FUNCTION document_extraction_guard();
CREATE TRIGGER document_extraction_guard BEFORE INSERT OR UPDATE OR DELETE ON extracted_field FOR EACH ROW EXECUTE FUNCTION document_extraction_guard();

CREATE FUNCTION document_legal_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u users;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'hold provenance is permanent'; END IF;
  SELECT * INTO u FROM users WHERE id = NEW."subjectUserId" FOR UPDATE;
  IF NOT FOUND OR u."tenantId" <> NEW."tenantId" THEN RAISE EXCEPTION 'hold tenant lineage mismatch'; END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'releasedAt' - 'releasedBy' - 'releaseReason') IS DISTINCT FROM (to_jsonb(OLD) - 'releasedAt' - 'releasedBy' - 'releaseReason') OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL) THEN RAISE EXCEPTION 'hold release is one way'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_legal_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON doc_legal_hold FOR EACH ROW EXECUTE FUNCTION document_legal_hold_guard();

CREATE FUNCTION document_purge_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c document_purge_claim;
BEGIN
  SELECT * INTO c FROM document_purge_claim WHERE id = NEW."purgeClaimId";
  IF NOT FOUND OR c."claimXid" = txid_current() OR c.state <> 'COMMITTED' OR c."tenantId" <> NEW."tenantId" OR c."documentId" <> NEW."submissionId" OR c."userId" <> NEW."subjectId" OR c.mode <> NEW.scope THEN RAISE EXCEPTION 'receipt claim mismatch'; END IF;
  IF NEW."verificationProbeResult" NOT IN ('CONFIRMED_ABSENT','NOT_APPLICABLE') OR (c."sourceKind" = 'OBJECT') <> (NEW."verificationProbeResult" = 'CONFIRMED_ABSENT') THEN RAISE EXCEPTION 'receipt probe scope mismatch'; END IF;
  IF c."sourceKind" = 'OBJECT' AND NOT EXISTS (SELECT 1 FROM encrypted_objects WHERE "sourceId" = c."sourceId" AND "retiredClaimId" = c.id AND "wrappedDek" IS NULL AND "shreddedAt" IS NOT NULL) THEN RAISE EXCEPTION 'receipt requires key absence'; END IF;
  IF c.mode = 'FULL_ERASURE' AND (EXISTS (SELECT 1 FROM extraction_run WHERE "submissionId" = c."documentId" AND "wrappedDek" IS NOT NULL) OR EXISTS (SELECT 1 FROM extracted_field WHERE "submissionId" = c."documentId" AND "valueCt" IS NOT NULL)) THEN RAISE EXCEPTION 'receipt requires field absence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_purge_receipt_guard BEFORE INSERT ON deletion_receipt FOR EACH ROW EXECUTE FUNCTION document_purge_receipt_guard();

CREATE FUNCTION document_purge_user_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."tenantId") IS DISTINCT FROM (OLD.id, OLD."tenantId") AND
    (EXISTS (SELECT 1 FROM document_purge_claim WHERE "userId" = OLD.id) OR EXISTS (SELECT 1 FROM doc_legal_hold WHERE "subjectUserId" = OLD.id)) THEN RAISE EXCEPTION 'preservation authority owner immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_purge_user_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION document_purge_user_guard();

CREATE FUNCTION document_purge_orphan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM document_purge_claim WHERE "orphanId" = OLD.id) AND
    ((to_jsonb(NEW) - 'purgedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'purgedAt') OR NEW."purgedAt" IS NULL) THEN RAISE EXCEPTION 'claimed orphan identity immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_purge_orphan_guard BEFORE UPDATE ON storage_orphans FOR EACH ROW EXECUTE FUNCTION document_purge_orphan_guard();

COMMIT;
