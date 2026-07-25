-- HND-001: brute-force lockout for the pickup handover code (parity with the
-- taxi ride PIN's ridePinAttempts). Additive, defaulted — existing orders start
-- at 0 attempts.
ALTER TABLE "orders" ADD COLUMN "pickupCodeAttempts" INTEGER NOT NULL DEFAULT 0;
