-- [NO-AI] RETIRE THE AI OPS-AGENT TABLES — WITHOUT DESTROYING THEIR EVIDENCE.
--
-- Swift no longer contains a model runtime. `agent_action_requests` and
-- `agent_audit_events` were written by the removed ops agent: what it proposed,
-- what a human approved, and what was executed. Their Prisma models and every
-- runtime caller are gone in this change.
--
-- WHAT THIS MIGRATION DOES NOT DO: drop the tables. They are the record of
-- privileged actions taken against real orders by a system that no longer
-- exists, and "we deleted the feature" is not a reason to delete the evidence
-- of what it did. If a customer or a regulator asks what was done to an order
-- in that period, the answer must still exist.
--
-- So the tables are RETIRED, not removed:
--   * renamed out of the live namespace, so no ORM regenerates a model for them
--     and no future migration silently reuses the name;
--   * marked read-only by a rule that refuses INSERT, UPDATE and DELETE, so
--     nothing can add to or quietly edit a closed record;
--   * commented with what they were and when they stopped.
--
-- A later, separate decision may export and drop them under the retention
-- schedule. That is a data-lifecycle decision with its own evidence, not a
-- side effect of removing a feature.
--
-- ROLLBACK:
--   ALTER TABLE "retired"."retired_agent_action_requests" SET SCHEMA "public";
--   ALTER TABLE "retired"."retired_agent_audit_events"    SET SCHEMA "public";
--   (then rename back and recreate the enum)
--   DROP RULE IF EXISTS no_insert ON "agent_action_requests"; ... (etc.)
-- Restoring the Prisma models is a code change, not a database one.

-- A dedicated schema, not a renamed table in `public`. Two reasons, and the
-- second is the one that matters: it puts the evidence outside the
-- application's namespace so nothing can address it by accident, and it keeps
-- `prisma migrate diff` honest — a retained table sitting in `public` with no
-- Prisma model is permanent schema drift, and a drift check that has to be
-- taught to ignore something stops being a check.
CREATE SCHEMA IF NOT EXISTS "retired";
COMMENT ON SCHEMA "retired" IS 'Read-only evidence from removed features. Never addressed by the application.';

ALTER TABLE IF EXISTS "agent_action_requests" SET SCHEMA "retired";
ALTER TABLE IF EXISTS "agent_audit_events"    SET SCHEMA "retired";
ALTER TABLE IF EXISTS "retired"."agent_action_requests" RENAME TO "retired_agent_action_requests";
ALTER TABLE IF EXISTS "retired"."agent_audit_events"    RENAME TO "retired_agent_audit_events";

COMMENT ON TABLE "retired"."retired_agent_action_requests" IS
  'RETIRED 2026-09-07 (NO-AI). Written by the removed ops agent. Read-only evidence; no runtime reads or writes it.';
COMMENT ON TABLE "retired"."retired_agent_audit_events" IS
  'RETIRED 2026-09-07 (NO-AI). Written by the removed ops agent. Read-only evidence; no runtime reads or writes it.';

CREATE OR REPLACE RULE "retired_no_insert" AS ON INSERT TO "retired"."retired_agent_action_requests" DO INSTEAD NOTHING;
CREATE OR REPLACE RULE "retired_no_update" AS ON UPDATE TO "retired"."retired_agent_action_requests" DO INSTEAD NOTHING;
CREATE OR REPLACE RULE "retired_no_delete" AS ON DELETE TO "retired"."retired_agent_action_requests" DO INSTEAD NOTHING;
CREATE OR REPLACE RULE "retired_no_insert" AS ON INSERT TO "retired"."retired_agent_audit_events" DO INSTEAD NOTHING;
CREATE OR REPLACE RULE "retired_no_update" AS ON UPDATE TO "retired"."retired_agent_audit_events" DO INSTEAD NOTHING;
CREATE OR REPLACE RULE "retired_no_delete" AS ON DELETE TO "retired"."retired_agent_audit_events" DO INSTEAD NOTHING;

-- The enum type goes, but its VALUES stay. The retired table's status column is
-- converted to text first, so every recorded status is preserved verbatim as
-- the label it always read as. Keeping a Prisma-less enum alive would leave the
-- schema permanently drifted from its migrations; converting the column removes
-- the dependency without touching a single recorded fact.
-- The column DEFAULT also references the type, and a default on a table that
-- refuses INSERT is meaningless anyway.
ALTER TABLE "retired"."retired_agent_action_requests" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "retired"."retired_agent_action_requests"
  ALTER COLUMN "status" TYPE text USING "status"::text;

DROP TYPE IF EXISTS "AgentActionStatus";
