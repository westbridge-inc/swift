-- Expand-only cross-device memory for dual Rider/Driver accounts. Nullable and
-- without a default so old application versions remain compatible during a
-- rolling deploy; ambiguous legacy rows are intentionally not guessed here.
CREATE TYPE "MoverRole" AS ENUM ('RIDER', 'DRIVER');

ALTER TABLE "users" ADD COLUMN "lastMoverRole" "MoverRole";
