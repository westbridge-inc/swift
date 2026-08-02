-- Ads §10.4: advisory-only AI/heuristic pre-screen annotations on creatives.
-- Additive (expand-only); assists the human reviewer, never decides.
ALTER TABLE "ad_creatives" ADD COLUMN "preScreen" JSONB;
