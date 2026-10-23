-- [O-2 · owner 22 Oct 2026] The takeaway pickup code is OFF by default for every store.
ALTER TABLE "vendors" ADD COLUMN "requirePickupCode" BOOLEAN NOT NULL DEFAULT false;
