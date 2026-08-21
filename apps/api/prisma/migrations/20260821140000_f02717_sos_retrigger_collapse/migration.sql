-- [F-027-17] Repeat SOS triggers collapse onto the caller's live alert.
--
-- The life-safety routes are exempt from the rate limiter (a throttle must
-- never stand between a person and help), which left the alert mint itself
-- unbounded: one authenticated account could raise an unlimited series of
-- distinct alerts and bury the ops war room, losing real emergencies in the
-- noise. Both directions are life-safety failures.
--
-- The resolution bounds the ALERTS, not the requests. A repeat trigger while
-- an alert is still live increments these columns instead of creating a new
-- row, so ops sees one incident with rising urgency — strictly more
-- information than N duplicates, and the caller is never refused.
--
-- Deliberately NOT a partial unique index on (actorUserId, orderId): a
-- database constraint that can REFUSE an insert is the same hazard as the
-- limiter, wearing a different coat. The collapse stays best-effort so it can
-- never block someone from raising an alert.
ALTER TABLE "SosAlert" ADD COLUMN "retriggerCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SosAlert" ADD COLUMN "lastRetriggerAt" TIMESTAMP(3);

-- Supports the live-alert lookup the collapse performs on every trigger.
CREATE INDEX "SosAlert_actorUserId_status_idx" ON "SosAlert" ("actorUserId", "status");
