-- Roll back the transition-table change only. Application code continues to
-- route automated adverse results to human review, so this does not itself
-- authorize a machine-only decision.
BEGIN;

INSERT INTO doc_state_transition ("fromState", "toState", event, spec)
VALUES (
  'VALIDATED'::"DocState",
  'REJECTED'::"DocState",
  'auto_reject',
  'X-AUTO-REJECT (legacy compatibility only)'
)
ON CONFLICT ("fromState", "toState")
DO UPDATE SET event = EXCLUDED.event, spec = EXCLUDED.spec;

COMMIT;
