-- [G1/G2] Per-item bulk, so a load can be banded by how much ROOM it takes
-- rather than by how many lines it has.
--
-- The defect this serves: vehicle capability is filtered on
-- `courierPackageSize`, written in exactly one place (courier.routes.ts:173).
-- Food and grocery orders never set it, and at dispatch.service.ts:550 a null
-- packageSize makes the vehicle clause `Prisma.empty` — the filter is not
-- relaxed, it is NOT EMITTED. The two highest-volume verticals therefore have
-- no capacity gate at all, and a 40-item supermarket run can be offered to and
-- accepted by a bicycle. In a cash model that is the worst place to fail: the
-- vendor has packed it and the rider has paid for it out of their own float
-- before anyone finds out it will not fit.
--
-- TWO columns, not one, and the second is the point:
--
--   items."bulkUnits"       the menu-level setting a shopkeeper edits
--   order_items."bulkUnits" a SNAPSHOT taken at order time
--
-- `order_items.itemId` is a DELIBERATE loose reference with NO foreign key
-- (ADR SWIFT-AUD-D5-04) — name and every price are already snapshotted so that
-- editing or deleting a menu item can never rewrite a delivered order. Load is
-- the same kind of fact: a vendor marking rice as bulky next week must not
-- retroactively change what an order dispatched last week weighed. Reading the
-- live item would make historic dispatch evidence mutable.
--
-- ADDITIVE ONLY, and nullable on purpose. NULL means "ordinary" (1 unit of
-- room), which is exactly how every existing row already behaves. Nothing
-- reads these yet: the load gate ships in SHADOW first and changes no
-- dispatch behaviour until the evidence says the bands are right.

-- [F-021-25] Bounded lock waits: DDL must never queue unboundedly behind traffic.
SET lock_timeout = '10s';

ALTER TABLE "items" ADD COLUMN "bulkUnits" INTEGER;
ALTER TABLE "order_items" ADD COLUMN "bulkUnits" INTEGER;
