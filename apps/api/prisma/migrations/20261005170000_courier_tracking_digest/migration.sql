-- Preserve active legacy links by digest, and retire expired/terminal grants.
-- No bearer value is restored on rollback: revoke every tracking grant instead.
UPDATE "orders" SET "courierTrackingToken" = CASE
  WHEN "orderType" = 'COURIER' AND "placedAt" > CURRENT_TIMESTAMP - INTERVAL '12 hours'
    AND "status" NOT IN ('DELIVERED','COMPLETED','CANCELLED','REFUNDED','FAILED','RETURNED')
  THEN encode(sha256(convert_to("courierTrackingToken", 'UTF8')), 'hex')
  ELSE NULL END
WHERE "courierTrackingToken" IS NOT NULL;
