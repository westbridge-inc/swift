-- Ops agent (spec Part B): approval queue + append-only audit log.
CREATE TYPE "AgentActionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED');

CREATE TABLE "agent_action_requests" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "reasoning" TEXT,
    "orderId" TEXT,
    "status" "AgentActionStatus" NOT NULL DEFAULT 'PENDING',
    "actionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "agent_action_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_action_requests_actionKey_key" ON "agent_action_requests"("actionKey");
CREATE INDEX "agent_action_requests_status_createdAt_idx" ON "agent_action_requests"("status", "createdAt");

CREATE TABLE "agent_audit_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "job" TEXT NOT NULL,
    "subjectId" TEXT,
    "action" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasoning" TEXT,

    CONSTRAINT "agent_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_audit_events_at_idx" ON "agent_audit_events"("at");
CREATE INDEX "agent_audit_events_subjectId_idx" ON "agent_audit_events"("subjectId");
