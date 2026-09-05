-- [DOC-1 DOC-INV-11] The same document bytes on two accounts is a HARD identity signal.
-- The decision-time rule (verification.service holdOnCrossSubjectCollision) captures it for
-- both accounts and overrules an auto-approve to human review. Enum value only.
-- AlterEnum
ALTER TYPE "IdentitySignalType" ADD VALUE 'DOC_CONTENT';

