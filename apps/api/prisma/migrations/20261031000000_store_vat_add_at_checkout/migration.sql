-- [VAT-DOCS · owner 30 Oct 2026] "Add VAT at checkout" (StoreVatMode ADD_VAT_AT_CHECKOUT): a VAT-registered store
-- whose prices EXCLUDE VAT types them as it always has; while a PERSON's approval of its VAT stands, the server adds
-- 14% INTO the price every customer sees and every order charges (items.basePrice / options.additionalPrice), and
-- keeps the typed price here. VAT Act Cap. 81:05 s.90(2): an advertised price includes the tax, so the customer
-- sees the full price before ordering and there is never a surprise at checkout.
--
-- ADDITIVE ONLY: two nullable columns. Every existing row reads NULL (its price is the price as typed), so no
-- price, total or money path changes until a store chooses the mode and a person approves its certificate.
-- Not platform config: no re-seed.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "items" ADD COLUMN "vatListedPrice" DECIMAL(10,2);
ALTER TABLE "options" ADD COLUMN "vatListedAdditionalPrice" DECIMAL(10,2);
