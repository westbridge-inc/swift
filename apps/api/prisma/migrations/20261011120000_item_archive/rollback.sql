-- Restores the previous shape. Archived rows become ordinary unavailable
-- items (still off sale); nothing is deleted.
ALTER TABLE "items" DROP CONSTRAINT "items_archived_unavailable";
ALTER TABLE "items" DROP COLUMN "archivedAt";
