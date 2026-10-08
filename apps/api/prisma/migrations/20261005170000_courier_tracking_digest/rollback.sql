-- Rollback: the forward step kept only one-way digests, so no bearer link can be
-- restored. Revoke every courier tracking grant; senders share a fresh link.
UPDATE "orders" SET "courierTrackingToken" = NULL WHERE "courierTrackingToken" IS NOT NULL;
