-- A store had no way to publish a number a customer could call BEFORE ordering.
--
-- `Vendor.phone` already exists, but it is the operational and account contact:
-- collected as free text at onboarding, frequently the owner's own line (which
-- for a small shop is also the number that receives their login OTP), and given
-- with no expectation of publication. It is correctly absent from
-- PUBLIC_VENDOR_SELECT, and exposing it would be a disclosure the vendor never
-- made. So publication gets its own opt-in column and `phone` is left alone.
--
-- Shaped after `mmgPayUrl`, which solved the same problem for payment links:
-- opt-in nullable column, NULL means the feature is off, validated on write and
-- re-validated on read (utils/vendor-public-phone.ts) because a stored row is
-- untrusted until the boundary that hands it to a customer's dialler.
--
-- Landlines are first-class: a fixed GTT line is what many shops answer, so the
-- validator privileges no mobile prefix. What it does enforce is a COMPLETE
-- national number, which is what makes it structurally impossible to publish an
-- emergency short code as a "call us" button.
--
-- ADDITIVE ONLY: one nullable column. Every existing row keeps NULL, which
-- means exactly what it means today — this store publishes no number.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "publicPhone" TEXT;
