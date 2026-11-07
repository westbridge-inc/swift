-- [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 17:31Z (a)] The self-declared (unregistered) tier is removed: only a
-- registered business, or a trader under their own name, joins Swift. The code stops writing and reading the tier in
-- the same change (no caps, no nudge, no promotion, no self-declaration); this makes sure no store row still names it.
-- A store still on the tier is a standard store from now on: its checklist asks for its business registration (or
-- the owner signs that it trades under their own name). Production holds no such store; the step is for any
-- database that does.
-- [REVIEW-M #2046 S4] vendors is a hot table: wait at most 10 s for a lock, then fail (retry) instead of queueing.
-- Data only for vendors (the VendorTier enum keeps its retired value, so an older release can still read the column
-- and be rolled back to), forward only, idempotent: a replay matches no row. No rollback.sql: the removed tier is not
-- coming back (owner ruling), and an older release reads a REGISTERED row correctly.
SET lock_timeout = '10s';

UPDATE "vendors"
SET "tier" = 'REGISTERED', "tierChangedAt" = CURRENT_TIMESTAMP,
    "tierNote" = 'unregistered tier removed (owner ruling 1 Nov 2026): standard checklist'
WHERE "tier" = 'UNREGISTERED';

-- The business profile (verification subjects) no longer defaults to the tier. Nothing reads these two columns; their
-- default now says what is true: no legal form is recorded, and the registry tier is STANDARD.
ALTER TABLE "business_profile" ALTER COLUMN "entityForm" SET DEFAULT 'UNDECLARED',
    ALTER COLUMN "tier" SET DEFAULT 'STANDARD';

UPDATE "business_profile" SET "entityForm" = 'UNDECLARED' WHERE "entityForm" = 'UNREGISTERED';

UPDATE "business_profile" SET "tier" = 'STANDARD' WHERE "tier" = 'TIER_UNREGISTERED';
