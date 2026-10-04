-- Legacy metadata was client-supplied and cannot certify historical traffic.
ALTER TABLE "ad_events" ADD COLUMN "authorityVersion" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "ad_events_campaignId_authorityVersion_idx" ON "ad_events"("campaignId", "authorityVersion");
