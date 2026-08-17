-- Expand-only session assurance. Existing rows are explicitly LEGACY: they
-- remain valid for ordinary accounts but the new application refuses and
-- revokes them if live User authority contains ADMIN or SUPER_ADMIN.
CREATE TYPE "SessionAuthMethod" AS ENUM ('LEGACY', 'PASSWORD', 'OTP');

ALTER TABLE "sessions"
ADD COLUMN "authMethod" "SessionAuthMethod" NOT NULL DEFAULT 'LEGACY';
