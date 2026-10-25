-- [DRILL-STORM · GUARDRAILS §3] Bounded re-paging of unacknowledged ops alerts.
-- An unacknowledged alert re-paged every recipient and texted every on-call
-- phone every 5 minutes, forever (staging: one weekly drill re-paged 4,976
-- times). The ladder now backs off per alert, and each person (and the on-call
-- list) is re-paged at most a few times an hour, every owed alert in ONE push.
-- These columns record what each person / the on-call list was last re-paged
-- about. Additive; constant defaults; no table rewrite.
SET lock_timeout = '10s';

ALTER TABLE "ops_alerts" ADD COLUMN "oncallTextedLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ops_alerts" ADD COLUMN "oncallTextedAt" TIMESTAMP(3);
ALTER TABLE "ops_alerts" ADD COLUMN "oncallTextedList" TEXT;

ALTER TABLE "ops_alert_recipients" ADD COLUMN "pagedLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ops_alert_recipients" ADD COLUMN "lastPagedAt" TIMESTAMP(3);

CREATE INDEX "ops_alert_recipients_userId_lastPagedAt_idx" ON "ops_alert_recipients"("userId", "lastPagedAt");

-- Every escalation so far already re-paged every recipient and texted the
-- on-call list (the old ladder did both on every escalation): record that, so
-- the deploy itself re-pages nobody about levels already paged.
UPDATE "ops_alerts" SET "oncallTextedLevel" = "escalationLevel", "oncallTextedAt" = "lastEscalatedAt" WHERE "escalationLevel" > 0;
UPDATE "ops_alert_recipients" r SET "pagedLevel" = a."escalationLevel", "lastPagedAt" = a."lastEscalatedAt"
  FROM "ops_alerts" a WHERE r."opsAlertId" = a."id" AND a."escalationLevel" > 0;
