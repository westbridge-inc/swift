-- [VERIFY-DOCS · owner ruling 7, 6 Oct 2026] The TIN certificate image leaves every store checklist.
-- A store that is VAT-registered may instead TYPE its VAT registration number, which a VAT tax invoice
-- to a VAT-registered recipient must show (VAT Act s.28(1), Schedule III para 1(c)). Optional, typed,
-- format-checked on write (vendor.routes), never looked up and never public.
--
-- ADDITIVE ONLY: one nullable column. Every existing row keeps NULL — no VAT number given.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "vendors" ADD COLUMN "vatRegistrationNumber" TEXT;
