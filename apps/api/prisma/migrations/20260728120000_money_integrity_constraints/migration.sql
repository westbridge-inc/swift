-- Enforce the founder's zero-commission (keep-100%) promise and the core money
-- invariants at the DATABASE, not just in application code. A stray write or a
-- bad migration can no longer persist a domain-forbidden state (e.g. a platform
-- markup) with only code to stop it.
--
-- These are raw-SQL CHECK constraints: Prisma can't express them in
-- schema.prisma, so — exactly like the dispatch GiST indexes — they live ONLY in
-- migrations, are invisible to `db push`, and are asserted by a dedicated CI
-- step against the `migrate deploy` database. Every existing write path already
-- satisfies them (subtotalMarkup / markupAmount / totalMarkup are always 0), so
-- adding them validates cleanly.

-- Zero-commission: Swift takes no cut and adds no customer-facing markup. This
-- is the single most important business invariant — the whole model rests on it.
ALTER TABLE "orders"
  ADD CONSTRAINT "chk_orders_zero_markup" CHECK ("subtotalMarkup" = 0);
ALTER TABLE "order_items"
  ADD CONSTRAINT "chk_order_items_zero_markup" CHECK ("markupAmount" = 0 AND "totalMarkup" = 0);

-- Money can never go negative (a discounted-order refund floors the subtotal at
-- 0 in closeLine; this pins that at the storage layer).
ALTER TABLE "orders"
  ADD CONSTRAINT "chk_orders_nonneg_money" CHECK ("totalAmount" >= 0 AND "subtotalBase" >= 0);

-- A line item is always at least one unit.
ALTER TABLE "order_items"
  ADD CONSTRAINT "chk_order_items_qty_positive" CHECK ("quantity" > 0);
