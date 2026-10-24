-- [Off-site erasure ledger · #1977 COORD ruling 21 Oct] A backup is older than the live database: an
-- erasure done after the newest backup exists only in the live database. If that database is lost,
-- a restore would bring the person back. So every erasure writes its ledger entry HERE, in the same
-- transaction as the erasure itself (database triggers: no code path can forget it), and a host unit
-- ships unshipped entries, encrypted to the owner's backup key, to the off-site backup bucket.
--
-- An entry holds what deploy/restore-erasure-ledger.sql reads from the live database: ids, timestamps
-- and already de-identified account columns, never personal data. Both tables are append-only. The
-- application role can read them and never write them: only the trigger functions below (SECURITY
-- DEFINER, owned by the migration owner) insert entries, and only the host unit records shipments.

CREATE TABLE "erasure_ledger_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "entry" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erasure_ledger_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "erasure_ledger_entry_kind_check" CHECK ("kind" IN (
      'receipts', 'destroyed_keys', 'retired_documents', 'shredded_runs', 'shredded_fields',
      'closed_accounts', 'deleted_rows', 'erased_rating_text', 'erased_outbox_text'))
);
CREATE INDEX "erasure_ledger_entry_createdAt_idx" ON "erasure_ledger_entry"("createdAt");

CREATE TABLE "erasure_ledger_shipment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entryId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erasure_ledger_shipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "erasure_ledger_shipment_entryId_key" ON "erasure_ledger_shipment"("entryId");
ALTER TABLE "erasure_ledger_shipment" ADD CONSTRAINT "erasure_ledger_shipment_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "erasure_ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: an entry or a shipment is never changed or removed.
CREATE OR REPLACE FUNCTION erasure_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only [off-site erasure ledger]', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER erasure_ledger_entry_append_only BEFORE UPDATE OR DELETE ON "erasure_ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_append_only();
CREATE TRIGGER erasure_ledger_shipment_append_only BEFORE UPDATE OR DELETE ON "erasure_ledger_shipment"
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_append_only();

-- One entry from the changed row: TG_ARGV[0] = kind, TG_ARGV[1..] = the columns the ledger keeps.
CREATE OR REPLACE FUNCTION erasure_ledger_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r jsonb := to_jsonb(NEW);
  e jsonb := '{}'::jsonb;
  i int;
BEGIN
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    e := e || jsonb_build_object(TG_ARGV[i], r -> TG_ARGV[i]);
  END LOOP;
  INSERT INTO erasure_ledger_entry (kind, entry) VALUES (TG_ARGV[0], e);
  RETURN NULL;
END $$;

-- A row the erasure deletes for a CLOSED account (its users row already carries the tombstone phone,
-- set at the authority cut-off before any cleanup). TG_ARGV[0] = the owner column, TG_ARGV[1] = the
-- row's ledger id ('id', 'accountId', or 'advertiser_member' = advertiserId/userId). Deletes of an
-- open account's rows (a logout, a cart checkout) are not erasures and write nothing.
CREATE OR REPLACE FUNCTION erasure_ledger_capture_closed_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r jsonb := to_jsonb(OLD);
  owner text := r ->> TG_ARGV[0];
  rid text;
BEGIN
  IF owner IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = owner AND u.phone = 'deleted:' || u.id) THEN
    RETURN NULL;
  END IF;
  rid := CASE TG_ARGV[1]
    WHEN 'advertiser_member' THEN (r ->> 'advertiserId') || '/' || (r ->> 'userId')
    ELSE r ->> TG_ARGV[1] END;
  INSERT INTO erasure_ledger_entry (kind, entry) VALUES ('deleted_rows', jsonb_build_object('tbl', TG_TABLE_NAME, 'id', rid));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION erasure_ledger_capture() FROM PUBLIC;
REVOKE ALL ON FUNCTION erasure_ledger_capture_closed_row() FROM PUBLIC;

-- The erasures (the same facts deploy/restore-erasure-ledger.sql reads from the live database).
CREATE TRIGGER erasure_ledger_receipts AFTER INSERT ON deletion_receipt
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture('receipts', 'id', 'tenantId', 'submissionId', 'subjectId', 'docTypeCode', 'contentSha256', 'bytesDeleted', 'deletedAt', 'deletedBy', 'storeLocations', 'verificationProbeResult');
CREATE TRIGGER erasure_ledger_destroyed_keys AFTER UPDATE OF "wrappedDek" ON encrypted_objects
  FOR EACH ROW WHEN (OLD."wrappedDek" IS NOT NULL AND NEW."wrappedDek" IS NULL)
  EXECUTE FUNCTION erasure_ledger_capture('destroyed_keys', 'fileKey', 'createdBy', 'shreddedAt');
CREATE TRIGGER erasure_ledger_retired_documents AFTER UPDATE ON verification_documents
  FOR EACH ROW WHEN (NEW."fileUrl" = '' AND (NEW."purgedAt" IS NOT NULL OR NEW."imagePurgedAt" IS NOT NULL)
    AND (OLD."fileUrl" IS DISTINCT FROM NEW."fileUrl" OR OLD."purgedAt" IS DISTINCT FROM NEW."purgedAt" OR OLD."imagePurgedAt" IS DISTINCT FROM NEW."imagePurgedAt"))
  EXECUTE FUNCTION erasure_ledger_capture('retired_documents', 'id', 'userId', 'purgedAt', 'imagePurgedAt');
CREATE TRIGGER erasure_ledger_shredded_runs AFTER UPDATE OF "wrappedDek" ON extraction_run
  FOR EACH ROW WHEN (OLD."wrappedDek" IS NOT NULL AND NEW."wrappedDek" IS NULL)
  EXECUTE FUNCTION erasure_ledger_capture('shredded_runs', 'id');
CREATE TRIGGER erasure_ledger_shredded_fields AFTER UPDATE OF "valueCt" ON extracted_field
  FOR EACH ROW WHEN (OLD."valueCt" IS NOT NULL AND NEW."valueCt" IS NULL)
  EXECUTE FUNCTION erasure_ledger_capture('shredded_fields', 'id');
-- A closed account: written once the tombstone is complete (never at the authority cut-off, when the
-- row still names the person). It carries the de-identified row AND the rows the closure KEPT (a held
-- liveness photo, for example), so a restore without the live database can remove everything else the
-- closure removed - including rows deleted before the tombstone, in the same closure.
CREATE OR REPLACE FUNCTION erasure_ledger_kept_rows(uid text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('tbl', k.tbl, 'id', k.id)), '[]'::jsonb) FROM (
    SELECT 'sessions' AS tbl, id::text AS id FROM sessions WHERE "userId" = uid
    UNION ALL SELECT 'device_tokens', id::text FROM device_tokens WHERE "userId" = uid
    UNION ALL SELECT 'verification_decision_outbox', id::text FROM verification_decision_outbox WHERE "userId" = uid
    UNION ALL SELECT 'advertiser_members', "advertiserId" || '/' || "userId" FROM advertiser_members WHERE "userId" = uid
    UNION ALL SELECT 'vendor_staff', id::text FROM vendor_staff WHERE "userId" = uid
    UNION ALL SELECT 'face_templates', "accountId" FROM face_templates WHERE "accountId" = uid
    UNION ALL SELECT 'identity_keys', id::text FROM identity_keys WHERE "accountId" = uid
    UNION ALL SELECT 'identity_cluster_members', "accountId" FROM identity_cluster_members WHERE "accountId" = uid
    UNION ALL SELECT 'addresses', id::text FROM addresses WHERE "userId" = uid
    UNION ALL SELECT 'account_recoveries', id::text FROM account_recoveries WHERE "userId" = uid
    UNION ALL SELECT 'LivenessCheck', id::text FROM "LivenessCheck" WHERE "userId" = uid
    UNION ALL SELECT 'trip_share_tokens', id::text FROM trip_share_tokens WHERE "createdByUserId" = uid
    UNION ALL SELECT 'EmergencyContact', id::text FROM "EmergencyContact" WHERE "userId" = uid
    UNION ALL SELECT 'ride_queue_entries', id::text FROM ride_queue_entries WHERE "customerId" = uid
    UNION ALL SELECT 'supply_watches', id::text FROM supply_watches WHERE "customerId" = uid
    UNION ALL SELECT 'carts', id::text FROM carts WHERE "customerId" = uid
    UNION ALL SELECT 'cart_merge_receipts', id::text FROM cart_merge_receipts WHERE "userId" = uid
    UNION ALL SELECT 'notifications', id::text FROM notifications WHERE "userId" = uid
    UNION ALL SELECT 'mover_revocation_outbox', id::text FROM mover_revocation_outbox WHERE "userId" = uid
    UNION ALL SELECT 'guardian_checkin_deliveries', id::text FROM guardian_checkin_deliveries WHERE "userId" = uid
    UNION ALL SELECT 'card_sessions', id::text FROM card_sessions WHERE "userId" = uid
    UNION ALL SELECT 'renewal_schedule', id::text FROM renewal_schedule WHERE "subjectId" = uid
    UNION ALL SELECT 'admins', id::text FROM admins WHERE "userId" = uid
  ) k
$$;
CREATE OR REPLACE FUNCTION erasure_ledger_capture_closed_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO erasure_ledger_entry (kind, entry) VALUES ('closed_accounts', jsonb_build_object(
    'id', NEW.id, 'status', NEW.status, 'firstName', NEW."firstName", 'lastName', NEW."lastName", 'email', NEW.email,
    'avatar', NEW.avatar, 'phone', NEW.phone, 'passwordHash', NEW."passwordHash", 'selfieCapturedAt', NEW."selfieCapturedAt",
    'isPhoneVerified', NEW."isPhoneVerified", 'isEmailVerified', NEW."isEmailVerified",
    'lastKnownLat', NEW."lastKnownLat", 'lastKnownLng', NEW."lastKnownLng",
    'kept', erasure_ledger_kept_rows(NEW.id)));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION erasure_ledger_kept_rows(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION erasure_ledger_capture_closed_account() FROM PUBLIC;
CREATE TRIGGER erasure_ledger_closed_accounts AFTER UPDATE ON users
  FOR EACH ROW WHEN (NEW.phone = 'deleted:' || NEW.id
    -- the complete tombstone (AccountService.deleteAccount step 4), never the cut-off's partial row
    AND NEW."firstName" = 'Deleted' AND NEW."lastName" = 'User' AND NEW.email IS NULL AND NEW."passwordHash" IS NULL
    AND NEW.avatar IS NULL AND NEW."lastKnownLat" IS NULL AND NEW."lastKnownLng" IS NULL
    AND (OLD.status, OLD."firstName", OLD."lastName", OLD.email, OLD.avatar, OLD.phone, OLD."passwordHash", OLD."selfieCapturedAt",
         OLD."isPhoneVerified", OLD."isEmailVerified", OLD."lastKnownLat", OLD."lastKnownLng")
        IS DISTINCT FROM (NEW.status, NEW."firstName", NEW."lastName", NEW.email, NEW.avatar, NEW.phone, NEW."passwordHash", NEW."selfieCapturedAt",
         NEW."isPhoneVerified", NEW."isEmailVerified", NEW."lastKnownLat", NEW."lastKnownLng"))
  EXECUTE FUNCTION erasure_ledger_capture_closed_account();
CREATE TRIGGER erasure_ledger_erased_rating_text AFTER UPDATE ON ratings
  FOR EACH ROW WHEN ((OLD.comment IS NOT NULL OR OLD.response IS NOT NULL) AND NEW.comment IS NULL AND NEW.response IS NULL)
  EXECUTE FUNCTION erasure_ledger_capture('erased_rating_text', 'id');
CREATE TRIGGER erasure_ledger_erased_outbox_text AFTER UPDATE OF payload ON rating_outbox
  FOR EACH ROW WHEN (jsonb_typeof(OLD.payload) = 'object' AND OLD.payload ? 'comment' AND NOT (NEW.payload ? 'comment'))
  EXECUTE FUNCTION erasure_ledger_capture('erased_outbox_text', 'id');

-- A KEPT row of a closed account that is deleted later (a hold released, a re-sweep): the replay must
-- drop it too. (Rows the closure itself deletes are covered by the kept list above.)
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON device_tokens FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON verification_decision_outbox FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON advertiser_members FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'advertiser_member');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON vendor_staff FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON face_templates FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('accountId', 'accountId');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON identity_keys FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('accountId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON identity_cluster_members FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('accountId', 'accountId');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON addresses FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON account_recoveries FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON "LivenessCheck" FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON trip_share_tokens FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('createdByUserId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON "EmergencyContact" FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON ride_queue_entries FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('customerId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON supply_watches FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('customerId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON carts FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('customerId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON cart_merge_receipts FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
-- [#1905] what account erasure also clears now (account-erasure-register ERASURE_CLEARED)
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON mover_revocation_outbox FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON guardian_checkin_deliveries FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON card_sessions FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON renewal_schedule FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('subjectId', 'id');
CREATE TRIGGER erasure_ledger_deleted_row AFTER DELETE ON admins FOR EACH ROW EXECUTE FUNCTION erasure_ledger_capture_closed_row('userId', 'id');

-- The application reads the ledger (the stale-shipment alert) and never writes it: the default
-- privileges hand swift_app full DML on a new table, so take the writes back (and the test-database
-- heal, appRoleDdl in src/lib/tenant-rls.ts, re-applies exactly these).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.erasure_ledger_entry FROM swift_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.erasure_ledger_shipment FROM swift_app;
