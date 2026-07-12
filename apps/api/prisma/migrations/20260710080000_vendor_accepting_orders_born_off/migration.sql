-- A store is born NOT accepting orders; verification completion turns commerce
-- on (and a lapsed required document turns it back off). Existing rows keep
-- their current value — this only changes the default for new stores.
ALTER TABLE "vendors" ALTER COLUMN "acceptingOrders" SET DEFAULT false;
