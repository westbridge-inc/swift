-- Founder decision 2026-07-20 (uber-grade DECISIONS #5): record the announced
-- late-cancel fee as a marker. Additive, default 0 — historical cancels
-- honestly read "no marker recorded".
ALTER TABLE "orders" ADD COLUMN "lateCancelFeeDue" INTEGER NOT NULL DEFAULT 0;
