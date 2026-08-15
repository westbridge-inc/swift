-- [danger #21] The recipient's client RENDERED the alert (offer card shown),
-- distinct from acknowledgedAt (the recipient ACTED). A timeout with neither
-- stamp is UNDELIVERABLE and must not decay the mover's acceptance rate.
ALTER TABLE "alert_deliveries" ADD COLUMN "seenAt" TIMESTAMP(3);
