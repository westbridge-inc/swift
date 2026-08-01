-- Evidence Vault hardening (safety spec §9.2 — audit finding F4, 2026-08-01).
-- The original vault had a BEFORE DELETE guard on EvidenceBundle but NO BEFORE
-- UPDATE guard, so a bundle under legal hold but not yet sealed (e.g. police
-- escalation on a fresh case) could be un-held with a raw UPDATE and then
-- deleted — defeating the "the database itself refuses" guarantee for
-- legal-hold-without-seal. This trigger makes seal + legal-hold monotonic at
-- the DB: once set they can never be cleared or forged, sealed or not.

CREATE OR REPLACE FUNCTION evidence_bundle_block_update_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD."sealedAt" IS NOT NULL AND NEW."sealedAt" IS DISTINCT FROM OLD."sealedAt" THEN
    RAISE EXCEPTION 'evidence bundle % is sealed — sealedAt is immutable', OLD."id";
  END IF;
  IF OLD."sealHash" IS NOT NULL AND NEW."sealHash" IS DISTINCT FROM OLD."sealHash" THEN
    RAISE EXCEPTION 'evidence bundle % is sealed — sealHash is immutable', OLD."id";
  END IF;
  IF OLD."legalHold" = true AND NEW."legalHold" = false THEN
    RAISE EXCEPTION 'evidence bundle % is under legal hold — cannot be cleared', OLD."id";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_bundle_no_update_sealed
BEFORE UPDATE ON "EvidenceBundle"
FOR EACH ROW EXECUTE FUNCTION evidence_bundle_block_update_sealed();
