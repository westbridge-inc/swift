-- [ROLE-DOCS · owner ruling 21 Oct 2026] A store may trade under its owner's own name (Business Names
-- (Registration) Act, Cap. 90:05, s.3: an individual's true surname with only their first names or initials needs
-- no registration). Set only by the owner's signed own-name declaration (vendor/own-name.ts). Every existing store
-- keeps the business-registration requirement it has today (default false).
ALTER TABLE "vendors" ADD COLUMN "tradesUnderOwnName" BOOLEAN NOT NULL DEFAULT false;
