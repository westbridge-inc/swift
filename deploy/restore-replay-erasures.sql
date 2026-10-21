-- [item 196] REPLAY THE LIVE ERASURE LEDGER ONTO A RESTORED COPY. Run by
-- deploy/restore.sh on the scratch database, inside the transaction that loaded
-- the restore_ledger_* tables (deploy/restore-erasure-ledger.sql says what each
-- holds). Any error aborts the transaction: the copy stays quarantined and the
-- restore is not reported.
--
-- The live database is the authority. Every statement copies the live state of
-- an erasure onto the copy and touches only rows that differ, so on a copy of a
-- fresh dump of the same live database it changes nothing (restore.sh
-- --compare-source then still finds the two equal). It never makes the copy hold
-- MORE than the live database does, only less.

CREATE TEMP TABLE restore_replay_changes (what text NOT NULL, n bigint NOT NULL) ON COMMIT DROP;

-- The ledger and the copy must describe the same objects. A key or a document
-- whose owner differs between the two is not this database's history: stop.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM encrypted_objects o JOIN restore_ledger_destroyed_keys k ON k."fileKey" = o."fileKey" WHERE o."createdBy" IS DISTINCT FROM k."createdBy") THEN
    RAISE EXCEPTION 'erasure replay: a destroyed key belongs to another person in the restored copy';
  END IF;
  IF EXISTS (SELECT 1 FROM verification_documents d JOIN restore_ledger_retired_documents l ON l.id = d.id WHERE d."userId" IS DISTINCT FROM l."userId") THEN
    RAISE EXCEPTION 'erasure replay: a retired document belongs to another person in the restored copy';
  END IF;
  IF EXISTS (SELECT 1 FROM deletion_receipt d JOIN restore_ledger_receipts r ON r.id = d.id
             WHERE (d."tenantId", d."submissionId", d."subjectId", d."docTypeCode", d."deletedAt", d."deletedBy", d."verificationProbeResult")
                   IS DISTINCT FROM (r."tenantId", r."submissionId", r."subjectId", r."docTypeCode", r."deletedAt", r."deletedBy", r."verificationProbeResult")) THEN
    RAISE EXCEPTION 'erasure replay: a deletion receipt differs between the live ledger and the restored copy';
  END IF;
END $$;

-- 1. Keys the live database destroyed stay destroyed (crypto-shred: without the
--    wrapped key the stored object is unreadable).
WITH c AS (
  UPDATE encrypted_objects o SET "wrappedDek" = NULL, "shreddedAt" = k."shreddedAt"
  FROM restore_ledger_destroyed_keys k
  WHERE o."fileKey" = k."fileKey" AND (o."wrappedDek" IS NOT NULL OR o."shreddedAt" IS DISTINCT FROM k."shreddedAt")
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'destroyed keys', count(*) FROM c;

-- 1b. A receipt names an object key the live database no longer holds at all:
--     the copy loses it too (same subject only, as the live shred did).
WITH c AS (
  UPDATE encrypted_objects o SET "wrappedDek" = NULL, "shreddedAt" = COALESCE(o."shreddedAt", r."deletedAt")
  FROM restore_ledger_receipts r CROSS JOIN LATERAL unnest(r."storeLocations") AS loc
  WHERE loc LIKE 'encrypted_object:%' AND o."fileKey" = substr(loc, 18) AND o."createdBy" = r."subjectId"
    AND o."wrappedDek" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM restore_ledger_destroyed_keys k WHERE k."fileKey" = o."fileKey")
    AND NOT EXISTS (SELECT 1 FROM restore_ledger_readable_receipt_keys k WHERE k."fileKey" = o."fileKey")
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'receipted keys', count(*) FROM c;

-- 2. Documents the live database retired (image or whole record purged).
WITH c AS (
  UPDATE verification_documents d SET "fileUrl" = '', "purgedAt" = l."purgedAt", "imagePurgedAt" = l."imagePurgedAt"
  FROM restore_ledger_retired_documents l
  WHERE d.id = l.id AND (d."fileUrl" <> '' OR d."purgedAt" IS DISTINCT FROM l."purgedAt" OR d."imagePurgedAt" IS DISTINCT FROM l."imagePurgedAt")
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'retired documents', count(*) FROM c;

-- 3. Extracted document values the live database shredded.
WITH c AS (
  UPDATE extraction_run e SET "wrappedDek" = NULL FROM restore_ledger_shredded_runs s
  WHERE e.id = s.id AND e."wrappedDek" IS NOT NULL RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'shredded extraction runs', count(*) FROM c;
WITH c AS (
  UPDATE extracted_field f SET "valueCt" = NULL FROM restore_ledger_shredded_fields s
  WHERE f.id = s.id AND f."valueCt" IS NOT NULL RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'shredded extracted values', count(*) FROM c;

-- 4. Closed accounts: the account row as the live database holds it now
--    (the tombstone phone, no name, e-mail, photo, password or location).
WITH c AS (
  UPDATE users u SET status = l.status, "firstName" = l."firstName", "lastName" = l."lastName", email = l.email,
    avatar = l.avatar, phone = l.phone, "passwordHash" = l."passwordHash", "selfieCapturedAt" = l."selfieCapturedAt",
    "isPhoneVerified" = l."isPhoneVerified", "isEmailVerified" = l."isEmailVerified",
    "lastKnownLat" = l."lastKnownLat", "lastKnownLng" = l."lastKnownLng"
  FROM restore_ledger_closed_accounts l
  WHERE u.id = l.id AND (u.status, u."firstName", u."lastName", u.email, u.avatar, u.phone, u."passwordHash", u."selfieCapturedAt",
                         u."isPhoneVerified", u."isEmailVerified", u."lastKnownLat", u."lastKnownLng")
        IS DISTINCT FROM (l.status, l."firstName", l."lastName", l.email, l.avatar, l.phone, l."passwordHash", l."selfieCapturedAt",
                          l."isPhoneVerified", l."isEmailVerified", l."lastKnownLat", l."lastKnownLng")
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'closed accounts', count(*) FROM c;

-- 5. What account closure removes (AccountService.deleteAccount, in its order):
--    a closed account keeps in the copy only the rows the live database kept.
CREATE TEMP TABLE restore_closed_ids ON COMMIT DROP AS SELECT id FROM restore_ledger_closed_accounts;
CREATE TEMP TABLE restore_kept_rows ON COMMIT DROP AS SELECT tbl, id FROM restore_ledger_closed_account_rows;
WITH c AS (DELETE FROM sessions t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'sessions' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'sessions', count(*) FROM c;
WITH c AS (DELETE FROM device_tokens t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'device_tokens' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'device tokens', count(*) FROM c;
WITH c AS (DELETE FROM verification_decision_outbox t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'verification_decision_outbox' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'queued approval work', count(*) FROM c;
WITH c AS (DELETE FROM advertiser_members t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'advertiser_members' AND k.id = t."advertiserId" || '/' || t."userId") RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'advertiser memberships', count(*) FROM c;
WITH c AS (DELETE FROM vendor_staff t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'vendor_staff' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'store team memberships', count(*) FROM c;
WITH c AS (DELETE FROM face_templates t USING restore_closed_ids x WHERE t."accountId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'face_templates' AND k.id = t."accountId") RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'face templates', count(*) FROM c;
WITH c AS (DELETE FROM identity_keys t USING restore_closed_ids x WHERE t."accountId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'identity_keys' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'identity keys', count(*) FROM c;
WITH c AS (DELETE FROM identity_cluster_members t USING restore_closed_ids x WHERE t."accountId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'identity_cluster_members' AND k.id = t."accountId") RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'identity cluster memberships', count(*) FROM c;
WITH c AS (DELETE FROM addresses t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'addresses' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'saved addresses', count(*) FROM c;
WITH c AS (DELETE FROM account_recoveries t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'account_recoveries' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'account recoveries', count(*) FROM c;
WITH c AS (DELETE FROM "LivenessCheck" t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'LivenessCheck' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'liveness checks', count(*) FROM c;
WITH c AS (DELETE FROM trip_share_tokens t USING restore_closed_ids x WHERE t."createdByUserId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'trip_share_tokens' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'trip shares', count(*) FROM c;
WITH c AS (DELETE FROM "EmergencyContact" t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'EmergencyContact' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'emergency contacts', count(*) FROM c;
WITH c AS (DELETE FROM ride_queue_entries t USING restore_closed_ids x WHERE t."customerId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'ride_queue_entries' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'ride queue entries', count(*) FROM c;
WITH c AS (DELETE FROM supply_watches t USING restore_closed_ids x WHERE t."customerId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'supply_watches' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'supply watches', count(*) FROM c;
WITH c AS (DELETE FROM carts t USING restore_closed_ids x WHERE t."customerId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'carts' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'carts', count(*) FROM c;
WITH c AS (DELETE FROM cart_merge_receipts t USING restore_closed_ids x WHERE t."userId" = x.id
  AND NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'cart_merge_receipts' AND k.id = t.id::text) RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'cart merge receipts', count(*) FROM c;

-- 6. Rating text by or about a closed account (scores stay, the words go).
WITH c AS (
  UPDATE ratings r SET comment = NULL, response = NULL, "respondedAt" = NULL, "respondedBy" = NULL
  FROM restore_ledger_erased_rating_text e
  WHERE r.id = e.id AND (r.comment IS NOT NULL OR r.response IS NOT NULL OR r."respondedAt" IS NOT NULL OR r."respondedBy" IS NOT NULL)
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'rating texts', count(*) FROM c;
WITH c AS (
  UPDATE rating_outbox o SET payload = o.payload - 'comment' FROM restore_ledger_erased_outbox_text e
  WHERE o.id = e.id AND jsonb_typeof(o.payload) = 'object' AND o.payload ? 'comment'
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'queued rating texts', count(*) FROM c;

-- 7. Receipts written after the backup join the copy's ledger (append-only:
--    inserted, never changed). A receipt for a tenant the copy does not hold
--    has nothing in the copy to describe and is counted, not inserted.
WITH c AS (
  INSERT INTO deletion_receipt (id, "tenantId", "submissionId", "subjectId", "docTypeCode", "contentSha256", "bytesDeleted", "deletedAt", "deletedBy", "storeLocations", "verificationProbeResult")
  SELECT r.id, r."tenantId", r."submissionId", r."subjectId", r."docTypeCode", r."contentSha256", r."bytesDeleted", r."deletedAt", r."deletedBy", r."storeLocations", r."verificationProbeResult"
  FROM restore_ledger_receipts r
  WHERE NOT EXISTS (SELECT 1 FROM deletion_receipt d WHERE d.id = r.id) AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = r."tenantId")
  RETURNING 1)
INSERT INTO restore_replay_changes SELECT 'deletion receipts added', count(*) FROM c;

-- The proof, before the transaction may commit.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM encrypted_objects o JOIN restore_ledger_destroyed_keys k USING ("fileKey") WHERE o."wrappedDek" IS NOT NULL) THEN
    RAISE EXCEPTION 'erasure replay: a key the live database destroyed is still readable in the restored copy';
  END IF;
  IF EXISTS (SELECT 1 FROM users u JOIN restore_ledger_closed_accounts l USING (id) WHERE u.phone IS DISTINCT FROM l.phone OR u."firstName" IS DISTINCT FROM l."firstName") THEN
    RAISE EXCEPTION 'erasure replay: a closed account still identifies its person in the restored copy';
  END IF;
  IF EXISTS (SELECT 1 FROM sessions s JOIN restore_closed_ids x ON x.id = s."userId"
             WHERE NOT EXISTS (SELECT 1 FROM restore_kept_rows k WHERE k.tbl = 'sessions' AND k.id = s.id::text)) THEN
    RAISE EXCEPTION 'erasure replay: a closed account still holds a session in the restored copy';
  END IF;
END $$;

SELECT format('erasure ledger replayed: %s destroyed keys, %s receipts, %s retired documents, %s closed accounts in the live ledger; changed in this copy: %s',
  (SELECT count(*) FROM restore_ledger_destroyed_keys), (SELECT count(*) FROM restore_ledger_receipts),
  (SELECT count(*) FROM restore_ledger_retired_documents), (SELECT count(*) FROM restore_ledger_closed_accounts),
  COALESCE((SELECT string_agg(format('%s %s', n, what), ', ' ORDER BY what) FROM restore_replay_changes WHERE n > 0), 'nothing (the copy already matched)'));
