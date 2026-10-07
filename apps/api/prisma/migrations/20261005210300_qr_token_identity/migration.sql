-- [row 106 · #1217 · coordinator contract M4] A printed QR token's identity is
-- permanent.
--
-- A QR sticker cannot be recalled. So the code's id and short code, and the
-- store it points at, must never be reissued to anyone else: not by editing the
-- row, not by changing its id while receipts survive, and not by deleting it
-- and creating a new one with the same identity for another store. Every issued
-- identity is reserved in a private registry (schema swift_qr, no grants to any
-- application role) by trigger-only SECURITY DEFINER functions; deleting a code
-- or a store RETIRES its reservations, it never frees them.
--
-- Backfill: every existing code is reserved with its exact target and
-- provenance; ids found only in receipts or credit rows (orphans) are reserved
-- already retired. Historical deleted tokens with no surviving evidence stay
-- UNVERIFIED; nothing is reconstructed by guesswork.
-- Rollback is monotonic: it drops nothing (see rollback.sql).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL row_security = off;
LOCK TABLE public.qr_codes, public.vendors, public.attribution_claims, public.pending_attributions,
  public.scan_events, public.scan_daily_rollups, public.orders IN SHARE MODE;

CREATE SCHEMA swift_qr;
REVOKE ALL ON SCHEMA swift_qr FROM PUBLIC;

CREATE TABLE swift_qr.token_identities (
  "qrCodeId"       text PRIMARY KEY,
  "shortCode"      text UNIQUE,
  "entityType"     text,
  "entityId"       text,
  "originTenantId" text,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "retiredAt"      timestamptz,
  CONSTRAINT token_identities_target_pair CHECK (("entityType" IS NULL) = ("entityId" IS NULL))
);
CREATE INDEX token_identities_target_idx ON swift_qr.token_identities ("entityType", "entityId");
REVOKE ALL ON TABLE swift_qr.token_identities FROM PUBLIC, swift_app, swift_bypass_rls;

-- BEGIN QR TOKEN BACKFILL
INSERT INTO swift_qr.token_identities ("qrCodeId", "shortCode", "entityType", "entityId", "originTenantId", "createdAt")
SELECT q.id, q."shortCode", q."entityType"::text, q."entityId", q."tenantId", q."createdAt" AT TIME ZONE 'UTC'
  FROM public.qr_codes q
ON CONFLICT DO NOTHING;
INSERT INTO swift_qr.token_identities ("qrCodeId", "retiredAt")
SELECT DISTINCT evidence.id, now() FROM (
  SELECT "qrCodeId" AS id FROM public.attribution_claims WHERE "qrCodeId" IS NOT NULL
  UNION SELECT "qrCodeId" FROM public.pending_attributions WHERE "qrCodeId" IS NOT NULL
  UNION SELECT "qrCodeId" FROM public.scan_events WHERE "qrCodeId" IS NOT NULL
  UNION SELECT "qrCodeId" FROM public.scan_daily_rollups WHERE "qrCodeId" IS NOT NULL
  UNION SELECT "attributionQrCodeId" FROM public.orders WHERE "attributionQrCodeId" IS NOT NULL
) evidence
WHERE NOT EXISTS (SELECT 1 FROM public.qr_codes q WHERE q.id = evidence.id)
ON CONFLICT DO NOTHING;
-- END QR TOKEN BACKFILL

-- Issue: reserve the identity of every new code. An id or short code ever
-- issued before is refused (the short code with the unique-violation shape the
-- generator's retry already handles).
CREATE FUNCTION swift_qr.qr_codes_token_reserve() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM swift_qr.token_identities t WHERE t."qrCodeId" = NEW.id) THEN
    RAISE EXCEPTION 'QR_TOKEN_TOMBSTONED: printed QR token id % was already issued and is never reissued', NEW.id
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM swift_qr.token_identities t WHERE t."shortCode" = NEW."shortCode") THEN
    RAISE EXCEPTION 'QR_TOKEN_TOMBSTONED: printed QR short code was already issued and is never reissued'
      USING ERRCODE = '23505', CONSTRAINT = 'qr_codes_shortCode_key';
  END IF;
  INSERT INTO swift_qr.token_identities ("qrCodeId", "shortCode", "entityType", "entityId", "originTenantId", "createdAt")
  VALUES (NEW.id, NEW."shortCode", NEW."entityType"::text, NEW."entityId", NEW."tenantId", NEW."createdAt" AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION swift_qr.qr_codes_token_reserve() FROM PUBLIC;
CREATE TRIGGER qr_codes_token_reserve BEFORE INSERT ON public.qr_codes
  FOR EACH ROW EXECUTE FUNCTION swift_qr.qr_codes_token_reserve();

-- Delete: the identity is retired, never freed.
CREATE FUNCTION swift_qr.qr_codes_token_retire() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
BEGIN
  UPDATE swift_qr.token_identities SET "retiredAt" = now() WHERE "qrCodeId" = OLD.id AND "retiredAt" IS NULL;
  IF NOT FOUND THEN
    INSERT INTO swift_qr.token_identities ("qrCodeId", "shortCode", "entityType", "entityId", "originTenantId", "createdAt", "retiredAt")
    VALUES (OLD.id, OLD."shortCode", OLD."entityType"::text, OLD."entityId", OLD."tenantId", OLD."createdAt" AT TIME ZONE 'UTC', now())
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION swift_qr.qr_codes_token_retire() FROM PUBLIC;
CREATE TRIGGER qr_codes_token_retire AFTER DELETE ON public.qr_codes
  FOR EACH ROW EXECUTE FUNCTION swift_qr.qr_codes_token_retire();

-- Edit: identity columns never change; the lifecycle only moves forward.
CREATE FUNCTION public.qr_codes_identity_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."shortCode" IS DISTINCT FROM OLD."shortCode"
     OR NEW."entityType" IS DISTINCT FROM OLD."entityType"
     OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'QR_TOKEN_IMMUTABLE: printed QR token identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status::text IS DISTINCT FROM OLD.status::text AND NOT (
       (OLD.status::text = 'ACTIVE' AND NEW.status::text IN ('SUPERSEDED', 'DEACTIVATED'))
    OR (OLD.status::text = 'SUPERSEDED' AND NEW.status::text = 'DEACTIVATED')) THEN
    RAISE EXCEPTION 'QR_TOKEN_LIFECYCLE: a QR code cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
     OR (OLD."deactivatedAt" IS NOT NULL AND NEW."deactivatedAt" IS DISTINCT FROM OLD."deactivatedAt") THEN
    RAISE EXCEPTION 'QR_TOKEN_LIFECYCLE: a recorded QR lifecycle time never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qr_codes_identity_immutable BEFORE UPDATE ON public.qr_codes
  FOR EACH ROW EXECUTE FUNCTION public.qr_codes_identity_immutable();

-- A store's id never changes, and an id that printed codes pointed at is never
-- given to a new store.
CREATE FUNCTION swift_qr.vendors_qr_target_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'QR_TARGET_IMMUTABLE: a store id never changes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM swift_qr.token_identities t WHERE t."entityType" = 'VENDOR' AND t."entityId" = NEW.id) THEN
    RAISE EXCEPTION 'QR_TARGET_RESERVED: store id % was the target of printed QR codes and is never reused', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION swift_qr.vendors_qr_target_identity() FROM PUBLIC;
CREATE TRIGGER vendors_qr_target_identity BEFORE INSERT OR UPDATE OF id ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION swift_qr.vendors_qr_target_identity();

-- Deleting a store retires its reservations in the same transaction.
CREATE FUNCTION swift_qr.vendors_qr_target_retire() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $$
BEGIN
  UPDATE swift_qr.token_identities SET "retiredAt" = now()
   WHERE "entityType" = 'VENDOR' AND "entityId" = OLD.id AND "retiredAt" IS NULL;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION swift_qr.vendors_qr_target_retire() FROM PUBLIC;
CREATE TRIGGER vendors_qr_target_retire AFTER DELETE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION swift_qr.vendors_qr_target_retire();

-- The registry itself: the only change ever allowed is the first retirement.
CREATE FUNCTION swift_qr.token_identities_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL
     AND NEW."qrCodeId" = OLD."qrCodeId"
     AND NEW."shortCode" IS NOT DISTINCT FROM OLD."shortCode"
     AND NEW."entityType" IS NOT DISTINCT FROM OLD."entityType"
     AND NEW."entityId" IS NOT DISTINCT FROM OLD."entityId"
     AND NEW."originTenantId" IS NOT DISTINCT FROM OLD."originTenantId"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'QR_TOKEN_REGISTRY_IMMUTABLE: an issued QR identity is permanent' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION swift_qr.token_identities_immutable() FROM PUBLIC;
CREATE TRIGGER token_identities_immutable BEFORE UPDATE OR DELETE ON swift_qr.token_identities
  FOR EACH ROW EXECUTE FUNCTION swift_qr.token_identities_immutable();

CREATE FUNCTION swift_qr.token_identities_no_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'QR_TOKEN_REGISTRY_IMMUTABLE: the QR identity registry is never truncated' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION swift_qr.token_identities_no_truncate() FROM PUBLIC;
CREATE TRIGGER token_identities_no_truncate BEFORE TRUNCATE ON swift_qr.token_identities
  FOR EACH STATEMENT EXECUTE FUNCTION swift_qr.token_identities_no_truncate();
COMMIT;
