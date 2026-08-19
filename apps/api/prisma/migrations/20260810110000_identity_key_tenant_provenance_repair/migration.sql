-- Identity matching is platform-wide, but IdentityKey.tenantId records the
-- tenant where the account belongs/capture occurred. Older verification and
-- capture callers hard-coded swift-default, corrupting that audit provenance
-- for non-default tenants. User tenant ownership is the authoritative source.
UPDATE "identity_keys" AS key
SET "tenantId" = account."tenantId"
FROM "users" AS account
WHERE key."accountId" = account."id"
  AND key."tenantId" IS DISTINCT FROM account."tenantId";
