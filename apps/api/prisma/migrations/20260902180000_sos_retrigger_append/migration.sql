-- [S-02] Concurrent SOS retriggers lose facts and the JSON array is unbounded.
-- Every repeat trigger is its own immutable, sequenced row; the alert's JSON
-- summary is bounded and derived. Request idempotency per (alert, requestKey).
CREATE TABLE "sos_retriggers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "sosAlertId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "requestKey" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "source" "SosTriggerSource" NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "addressText" TEXT,
    "counterpartyUserId" TEXT,
    "actorRole" TEXT NOT NULL,
    "clientCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sos_retriggers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sos_retriggers_sosAlertId_seq_key" ON "sos_retriggers"("sosAlertId", "seq");
CREATE UNIQUE INDEX "sos_retriggers_sosAlertId_requestKey_key" ON "sos_retriggers"("sosAlertId", "requestKey");
CREATE INDEX "sos_retriggers_tenantId_sosAlertId_idx" ON "sos_retriggers"("tenantId", "sosAlertId");
ALTER TABLE "sos_retriggers" ADD CONSTRAINT "sos_retriggers_sosAlertId_fkey" FOREIGN KEY ("sosAlertId") REFERENCES "SosAlert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A fact, once written, is never rewritten: coordinates and provenance are immutable.
CREATE OR REPLACE FUNCTION sos_retriggers_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sos_retriggers rows are immutable (S-02): append a new row';
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sos_retriggers_immutable_trg ON "sos_retriggers";
CREATE TRIGGER sos_retriggers_immutable_trg BEFORE UPDATE ON "sos_retriggers" FOR EACH ROW EXECUTE FUNCTION sos_retriggers_immutable();

ALTER TABLE "sos_retriggers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "sos_retriggers";
CREATE POLICY "tenant_isolation" ON "sos_retriggers"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
