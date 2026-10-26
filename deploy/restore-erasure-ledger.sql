-- [item 196] THE ERASURE LEDGER a restore replays. Read by deploy/restore.sh.
--
-- A backup is older than the live database. Anyone erased since then (a closed
-- account, a purged document, a destroyed key) is still whole in the backup,
-- so a restore must re-apply the LIVE database's erasures before it reports
-- success. This file says what to read from the live database; the matching
-- changes to the restored copy are in deploy/restore-replay-erasures.sql.
--
-- Format: each entry is a line "-- ledger: <name>" followed by ONE line, a
-- SELECT that runs on the LIVE database. restore.sh creates the temporary table
-- restore_ledger_<name> on the scratch copy from the same SELECT (no rows, the
-- copy's own column types), streams the live rows into it, and then runs the
-- replay file there, all in one transaction. The rows are ids, timestamps and
-- de-identified account columns, never personal data: closed accounts are
-- already de-identified in the live database.
--
-- A database without deletion_receipt has no erasure ledger and is skipped.
-- Every other failure (a missing table or column on either side) fails the
-- restore: the copy stays quarantined and is never reported as restored.

-- ledger: destroyed_keys
SELECT "fileKey", "createdBy", "shreddedAt" FROM encrypted_objects WHERE "wrappedDek" IS NULL

-- ledger: readable_receipt_keys
SELECT "fileKey" FROM encrypted_objects WHERE "wrappedDek" IS NOT NULL AND "fileKey" IN (SELECT substr(loc, 18) FROM deletion_receipt CROSS JOIN LATERAL unnest("storeLocations") AS loc WHERE loc LIKE 'encrypted_object:%')

-- ledger: receipts
SELECT id, "tenantId", "submissionId", "subjectId", "docTypeCode", "contentSha256", "bytesDeleted", "deletedAt", "deletedBy", "storeLocations", "verificationProbeResult" FROM deletion_receipt

-- ledger: retired_documents
SELECT id, "userId", "purgedAt", "imagePurgedAt" FROM verification_documents WHERE "fileUrl" = '' AND ("purgedAt" IS NOT NULL OR "imagePurgedAt" IS NOT NULL)

-- ledger: shredded_runs
SELECT id FROM extraction_run WHERE "wrappedDek" IS NULL

-- ledger: shredded_fields
SELECT id FROM extracted_field WHERE "valueCt" IS NULL

-- ledger: closed_accounts
SELECT id, status, "firstName", "lastName", email, avatar, phone, "passwordHash", "selfieCapturedAt", "isPhoneVerified", "isEmailVerified", "lastKnownLat", "lastKnownLng" FROM users WHERE phone = 'deleted:' || id

-- ledger: closed_account_rows
SELECT 'sessions' AS tbl, id::text AS id FROM sessions WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'device_tokens', id::text FROM device_tokens WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'addresses', id::text FROM addresses WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'account_recoveries', id::text FROM account_recoveries WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'LivenessCheck', id::text FROM "LivenessCheck" WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'trip_share_tokens', id::text FROM trip_share_tokens WHERE "createdByUserId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'EmergencyContact', id::text FROM "EmergencyContact" WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'ride_queue_entries', id::text FROM ride_queue_entries WHERE "customerId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'supply_watches', id::text FROM supply_watches WHERE "customerId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'carts', id::text FROM carts WHERE "customerId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'cart_merge_receipts', id::text FROM cart_merge_receipts WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'face_templates', "accountId" FROM face_templates WHERE "accountId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'identity_keys', id::text FROM identity_keys WHERE "accountId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'identity_cluster_members', "accountId" FROM identity_cluster_members WHERE "accountId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'advertiser_members', "advertiserId" || '/' || "userId" FROM advertiser_members WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'vendor_staff', id::text FROM vendor_staff WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'verification_decision_outbox', id::text FROM verification_decision_outbox WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'notifications', id::text FROM notifications WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'mover_revocation_outbox', id::text FROM mover_revocation_outbox WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'guardian_checkin_deliveries', id::text FROM guardian_checkin_deliveries WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'card_sessions', id::text FROM card_sessions WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'renewal_schedule', id::text FROM renewal_schedule WHERE "subjectId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'admins', id::text FROM admins WHERE "userId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) UNION ALL SELECT 'call_sessions', id::text FROM call_sessions WHERE "callerUserId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id)

-- ledger: erased_rating_text
SELECT id FROM ratings WHERE ("raterId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) OR "rateeId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id)) AND comment IS NULL AND response IS NULL AND "respondedAt" IS NULL AND "respondedBy" IS NULL

-- ledger: erased_outbox_text
SELECT id FROM rating_outbox WHERE "ratingId" IN (SELECT id FROM ratings WHERE "raterId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id) OR "rateeId" IN (SELECT id FROM users WHERE phone = 'deleted:' || id)) AND NOT (jsonb_typeof(payload) = 'object' AND payload ? 'comment')
