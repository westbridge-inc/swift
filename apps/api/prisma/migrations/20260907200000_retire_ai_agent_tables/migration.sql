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
--   * marked read-only by rules that refuse INSERT, UPDATE and DELETE, so no
--     ordinary statement can add to or quietly edit a closed record. Stated
--     precisely, because a rule is not a permission: `DO INSTEAD NOTHING` does
--     NOT constrain `COPY ... FROM`, is bypassed by `TRUNCATE`, and says
--     nothing about `DROP TABLE` or `ALTER TABLE`. It closes the application's
--     doors, not a superuser's;
--   * commented with what they were and when they stopped.
--
-- A later, separate decision may export and drop them under the retention
-- schedule. That is a data-lifecycle decision with its own evidence, not a
-- side effect of removing a feature.
--
-- BACKUP CHECKPOINT: immediately before `prisma migrate deploy` applies this,
-- take the "pre-20260907200000 agent evidence export" in addition to the
-- standard full pre-deploy backup:
--   pg_dump -Fc --data-only -t public.agent_action_requests -t public.agent_audit_events
--
-- ROLLBACK: the exact inverse below, verified on PostgreSQL 16, restores the
-- prior schema exactly, keeps every row, and deletes this migration's
-- _prisma_migrations row. It restores the database only: restoring the Prisma
-- models is a code change, and rows lost while retired (the rules do not block
-- TRUNCATE) come back only from the export above.
--   BEGIN;
--   SET LOCAL lock_timeout = '10s';
--   -- COPY and superuser writes bypass the rules; refuse rather than fail half-way on a non-enum status.
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM "retired"."retired_agent_action_requests"
--                WHERE "status" NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED')) THEN
--       RAISE EXCEPTION 'refusing rollback: a retired status value is not an AgentActionStatus label';
--     END IF;
--   END $$;
--   CREATE TYPE "public"."AgentActionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED');
--   DROP RULE "retired_no_insert" ON "retired"."retired_agent_action_requests";
--   DROP RULE "retired_no_update" ON "retired"."retired_agent_action_requests";
--   DROP RULE "retired_no_delete" ON "retired"."retired_agent_action_requests";
--   DROP RULE "retired_no_insert" ON "retired"."retired_agent_audit_events";
--   DROP RULE "retired_no_update" ON "retired"."retired_agent_audit_events";
--   DROP RULE "retired_no_delete" ON "retired"."retired_agent_audit_events";
--   ALTER TABLE "retired"."retired_agent_action_requests"
--     ALTER COLUMN "status" TYPE "public"."AgentActionStatus" USING "status"::"public"."AgentActionStatus";
--   ALTER TABLE "retired"."retired_agent_action_requests"
--     ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."AgentActionStatus";
--   COMMENT ON TABLE "retired"."retired_agent_action_requests" IS NULL;
--   COMMENT ON TABLE "retired"."retired_agent_audit_events" IS NULL;
--   ALTER TABLE "retired"."retired_agent_action_requests" RENAME TO "agent_action_requests";
--   ALTER TABLE "retired"."retired_agent_audit_events" RENAME TO "agent_audit_events";
--   ALTER TABLE "retired"."agent_action_requests" SET SCHEMA "public";
--   ALTER TABLE "retired"."agent_audit_events" SET SCHEMA "public";
--   DROP SCHEMA "retired";  -- RESTRICT (default): refuses if anything else was ever placed in it
--   DO $$ DECLARE n integer; BEGIN
--     DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260907200000_retire_ai_agent_tables';
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected exactly one _prisma_migrations row, deleted %', n; END IF;
--   END $$;
--   COMMIT;

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

-- Everything below addresses the retired tables by name. The four ALTERs above
-- are written IF EXISTS, which only makes sense if they may be absent — and on
-- exactly that database (one where a `prisma db push` already removed them)
-- these statements would abort `migrate deploy` part-way and block every later
-- migration until _prisma_migrations was hand-repaired. So the guard is carried
-- all the way through rather than half-way.
DO $retire$
BEGIN
  IF to_regclass('"retired"."retired_agent_action_requests"') IS NULL
     OR to_regclass('"retired"."retired_agent_audit_events"') IS NULL THEN
    RAISE NOTICE 'retire_ai_agent_tables: agent tables absent; nothing to retire';
    RETURN;
  END IF;

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
END
$retire$;

DROP TYPE IF EXISTS "AgentActionStatus";
