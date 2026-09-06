/**
 * [DOC-1 Part V · P5-1] The document state machine.
 *
 * ONE table of transitions (`DOC_TRANSITIONS`, §5.1 T1–T24 + named extensions) is the
 * rule. It is mirrored into `doc_state_transition` by migration and enforced by a
 * BEFORE INSERT OR UPDATE trigger on verification_documents (`docStateMachineDdl`), so
 * no writer — service, route, job, raw SQL — can move a document along a pair that is
 * not in the table, commit it without provenance, auto-approve it over a blocking FAIL,
 * purge it under a legal hold, or move it out of PURGED. The five illegal transitions of
 * §5.2 are refused by the database, not by discipline; `doc1-state-machine.test.ts`
 * names them.
 *
 * Legacy `status` is the projection of `state` (`LEGACY_STATUS_OF`), kept by the same
 * trigger; a legacy writer that changes only `status` gets the derived state AND the
 * same checks (a status write is not a bypass). Rulings (delegated, 2026-09-06):
 *  - LEGAL_HOLD is an overlay (`legalHoldId`), never a stored state: T21/T22 are the
 *    hold's own placement/release and the trigger refuses `state = 'LEGAL_HOLD'`.
 *  - X-AUTO-REJECT: the processor's REJECTED verdict still rejects at submission
 *    (VALIDATED → REJECTED). The spec's table has no automated rejection — flagged
 *    CONFLICT-DOC-8 for the founder; kept because the actor resubmits at once.
 *  - X-RELEASE: a reviewer handing a case back is IN_REVIEW → REVIEW_QUEUED (same pair
 *    as T15). X-IMPLICIT-CLAIM: a decision on an unclaimed document passes through
 *    IN_REVIEW in the same transaction — the table never allows REVIEW_QUEUED → APPROVED.
 *  - X-EXPIRE-PENDING: a document that lapses while awaiting a human expires too.
 *  - X-PURGE-ANY: retention / erasure purge is allowed from every non-PURGED state
 *    (T18 and T24 are the spec's two; departure erasure needs the rest).
 */
import type { DocState, Prisma, VerificationDocumentStatus } from '@prisma/client';

export const DOC_STATES = [
  'CAPTURED', 'PREPROCESSED', 'EXTRACTING', 'EXTRACTED', 'VALIDATED',
  'AUTO_APPROVED', 'REVIEW_QUEUED', 'IN_REVIEW', 'INFO_REQUESTED',
  'APPROVED', 'REJECTED', 'COMMITTED', 'PURGED',
  'EXPIRED', 'SUPERSEDED', 'REVOKED', 'LEGAL_HOLD',
] as const satisfies readonly DocState[];

export type DocEvent =
  | 'preprocess' | 'preprocess_fail' | 'extract' | 'extraction_ok' | 'extraction_fail'
  | 'validate' | 'route' | 'auto_reject' | 'qa_sample' | 'claim' | 'decide' | 'resubmit'
  | 'commit' | 'purge' | 'expire' | 'revoke' | 'supersede';

export interface DocTransition {
  from: DocState;
  to: DocState;
  event: DocEvent;
  /** The §5.1 row (T-number) or the named extension that licenses the pair. */
  spec: string;
}

/** Every state a purge may start from: all but the terminal PURGED and the overlay LEGAL_HOLD. */
const PURGEABLE = DOC_STATES.filter((s) => s !== 'PURGED' && s !== 'LEGAL_HOLD');

export const DOC_TRANSITIONS: readonly DocTransition[] = [
  { from: 'CAPTURED', to: 'PREPROCESSED', event: 'preprocess', spec: 'T2' },
  { from: 'CAPTURED', to: 'REJECTED', event: 'preprocess_fail', spec: 'T3' },
  { from: 'PREPROCESSED', to: 'EXTRACTING', event: 'extract', spec: 'T4' },
  { from: 'EXTRACTING', to: 'EXTRACTED', event: 'extraction_ok', spec: 'T5' },
  { from: 'EXTRACTING', to: 'REVIEW_QUEUED', event: 'extraction_fail', spec: 'T6' },
  { from: 'EXTRACTED', to: 'VALIDATED', event: 'validate', spec: 'T7' },
  { from: 'VALIDATED', to: 'AUTO_APPROVED', event: 'route', spec: 'T8' },
  { from: 'VALIDATED', to: 'REVIEW_QUEUED', event: 'route', spec: 'T9' },
  { from: 'VALIDATED', to: 'REJECTED', event: 'auto_reject', spec: 'X-AUTO-REJECT (CONFLICT-DOC-8)' },
  { from: 'AUTO_APPROVED', to: 'REVIEW_QUEUED', event: 'qa_sample', spec: 'T10' },
  { from: 'REVIEW_QUEUED', to: 'IN_REVIEW', event: 'claim', spec: 'T11' },
  { from: 'IN_REVIEW', to: 'APPROVED', event: 'decide', spec: 'T12' },
  { from: 'IN_REVIEW', to: 'REJECTED', event: 'decide', spec: 'T13' },
  { from: 'IN_REVIEW', to: 'INFO_REQUESTED', event: 'decide', spec: 'T14' },
  { from: 'IN_REVIEW', to: 'REVIEW_QUEUED', event: 'decide', spec: 'T15 escalate · X-RELEASE' },
  { from: 'INFO_REQUESTED', to: 'SUPERSEDED', event: 'resubmit', spec: 'T16' },
  { from: 'APPROVED', to: 'COMMITTED', event: 'commit', spec: 'T17' },
  { from: 'AUTO_APPROVED', to: 'COMMITTED', event: 'commit', spec: 'T17' },
  { from: 'COMMITTED', to: 'EXPIRED', event: 'expire', spec: 'T20' },
  { from: 'COMMITTED', to: 'REVOKED', event: 'revoke', spec: 'T23' },
  { from: 'COMMITTED', to: 'SUPERSEDED', event: 'supersede', spec: '§22 renewal' },
  { from: 'REVIEW_QUEUED', to: 'EXPIRED', event: 'expire', spec: 'X-EXPIRE-PENDING' },
  { from: 'IN_REVIEW', to: 'EXPIRED', event: 'expire', spec: 'X-EXPIRE-PENDING' },
  { from: 'INFO_REQUESTED', to: 'EXPIRED', event: 'expire', spec: 'X-EXPIRE-PENDING' },
  ...PURGEABLE.map((from): DocTransition => ({
    from, to: 'PURGED', event: 'purge',
    spec: from === 'COMMITTED' ? 'T18' : from === 'REJECTED' ? 'T24' : 'X-PURGE-ANY',
  })),
];

/**
 * The legacy projection: what `status` reads for each state. `null` = the status
 * is left as it was (a purge or a supersession does not rewrite history).
 */
export const LEGACY_STATUS_OF: Record<DocState, VerificationDocumentStatus | null> = {
  CAPTURED: 'PENDING', PREPROCESSED: 'PENDING', EXTRACTING: 'PENDING', EXTRACTED: 'PENDING',
  VALIDATED: 'PENDING', REVIEW_QUEUED: 'PENDING', IN_REVIEW: 'PENDING', INFO_REQUESTED: 'PENDING',
  APPROVED: 'APPROVED', AUTO_APPROVED: 'APPROVED', COMMITTED: 'APPROVED',
  REJECTED: 'REJECTED', REVOKED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  PURGED: null, SUPERSEDED: null, LEGAL_HOLD: null,
};

/** The state a legacy row (status only) is in — the migration backfill and the INSERT trigger use this. */
export function legacyToState(status: VerificationDocumentStatus, purgedAt: Date | null): DocState {
  if (purgedAt) return 'PURGED';
  if (status === 'APPROVED') return 'COMMITTED';
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'EXPIRED') return 'EXPIRED';
  return 'REVIEW_QUEUED';
}

/** The state readers act on: the hold overlay wins; a pre-trigger null derives from the legacy status. */
export function effectiveDocState(doc: {
  state: DocState | null; status: VerificationDocumentStatus; purgedAt: Date | null; legalHoldId: string | null;
}): DocState {
  if (doc.legalHoldId) return 'LEGAL_HOLD';
  return doc.state ?? legacyToState(doc.status, doc.purgedAt);
}

export function isTransitionAllowed(from: DocState, to: DocState): boolean {
  return DOC_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** The Postgres error text the trigger raises; routes map it to 409 DOC_STATE_ILLEGAL. */
export const DOC_STATE_ILLEGAL = 'DOC_STATE_ILLEGAL';

export function isDocStateViolation(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes(DOC_STATE_ILLEGAL);
}

/**
 * A CAS hop: moves ONE document from `from` to `to` (or from a pre-trigger null state).
 * Returns whether the row moved. The trigger, not this function, judges the pair.
 */
export async function hopDocState(
  tx: Prisma.TransactionClient,
  where: { id: string; userId?: string },
  from: DocState | readonly DocState[],
  to: DocState,
  extra: Prisma.VerificationDocumentUpdateManyMutationInput = {},
): Promise<boolean> {
  const froms = Array.isArray(from) ? (from as DocState[]) : [from as DocState];
  const won = await tx.verificationDocument.updateMany({
    where: { ...where, OR: [{ state: { in: froms } }, { state: null }] },
    data: { ...extra, state: to },
  });
  return won.count === 1;
}

const sqlLit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * The DDL: two pure functions (projection + legacy derivation), the transition-table
 * seed (exactly the TS table — extra rows are deleted), and the trigger. The migration
 * mirrors these statements verbatim (asserted by the suite); db-push environments
 * install them idempotently.
 */
export function docStateMachineDdl(): string[] {
  const legacyCases = DOC_STATES
    .map((s) => `    WHEN ${sqlLit(s)} THEN ${LEGACY_STATUS_OF[s] ? `${sqlLit(LEGACY_STATUS_OF[s]!)}::"VerificationDocumentStatus"` : 'NULL'}`)
    .join('\n');
  const rows = DOC_TRANSITIONS
    .map((t) => `  (${sqlLit(t.from)}, ${sqlLit(t.to)}, ${sqlLit(t.event)}, ${sqlLit(t.spec)})`)
    .join(',\n');
  const pairs = DOC_TRANSITIONS.map((t) => `(${sqlLit(t.from)}, ${sqlLit(t.to)})`).join(', ');
  return [
    `CREATE OR REPLACE FUNCTION doc_state_legacy_status(s "DocState") RETURNS "VerificationDocumentStatus"
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s
${legacyCases}
  END
$$;`,
    `CREATE OR REPLACE FUNCTION doc_state_from_legacy(st "VerificationDocumentStatus", purged timestamptz) RETURNS "DocState"
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN purged IS NOT NULL THEN 'PURGED'::"DocState"
    WHEN st = 'APPROVED' THEN 'COMMITTED'::"DocState"
    WHEN st = 'REJECTED' THEN 'REJECTED'::"DocState"
    WHEN st = 'EXPIRED' THEN 'EXPIRED'::"DocState"
    ELSE 'REVIEW_QUEUED'::"DocState"
  END
$$;`,
    `INSERT INTO doc_state_transition ("fromState", "toState", event, spec) VALUES
${rows}
ON CONFLICT ("fromState", "toState") DO UPDATE SET event = EXCLUDED.event, spec = EXCLUDED.spec;`,
    `DELETE FROM doc_state_transition WHERE ("fromState", "toState") NOT IN (${pairs});`,
    `CREATE OR REPLACE FUNCTION verification_documents_doc_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  via_approved boolean := false;
BEGIN
  IF NEW.state = 'LEGAL_HOLD' THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: LEGAL_HOLD is an overlay (legalHoldId), never a stored state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state IS NULL THEN
      NEW.state := doc_state_from_legacy(NEW.status, NEW."purgedAt");
    ELSE
      NEW.status := COALESCE(doc_state_legacy_status(NEW.state), NEW.status);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state IS NULL THEN
    NEW.state := OLD.state;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    -- state-driven write: the projection follows the state
    NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR (NEW."purgedAt" IS NOT NULL AND OLD."purgedAt" IS NULL) THEN
    -- legacy-driven write: derive the state, then judge it like any other
    NEW.state := doc_state_from_legacy(NEW.status, NEW."purgedAt");
    IF NEW.state = 'COMMITTED' AND OLD.state NOT IN ('APPROVED', 'AUTO_APPROVED') THEN
      -- a legacy approval passes through APPROVED on its way to COMMITTED (T12 then T17)
      IF NOT EXISTS (SELECT 1 FROM doc_state_transition t WHERE t."fromState" = OLD.state AND t."toState" = 'APPROVED') THEN
        RAISE EXCEPTION 'DOC_STATE_ILLEGAL: % -> APPROVED is not a transition', OLD.state;
      END IF;
      via_approved := true;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NOT via_approved AND NOT EXISTS (
    SELECT 1 FROM doc_state_transition t WHERE t."fromState" = OLD.state AND t."toState" = NEW.state
  ) THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: % -> % is not a transition', OLD.state, NEW.state;
  END IF;

  IF NEW.state = 'PURGED' AND NEW."legalHoldId" IS NOT NULL THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: PURGED under a legal hold';
  END IF;

  IF NEW.state = 'AUTO_APPROVED' AND EXISTS (
    SELECT 1 FROM validation_result v WHERE v."submissionId" = NEW.id AND v."isBlocking" AND v.status = 'FAIL'
  ) THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: AUTO_APPROVED with a blocking FAIL';
  END IF;

  IF NEW.state = 'COMMITTED' AND NOT (
    EXISTS (
      SELECT 1 FROM review_decision d JOIN review_case c ON c.id = d."caseId"
      WHERE c."submissionId" = NEW.id AND d.outcome = 'APPROVE'
    )
    OR (OLD.state = 'AUTO_APPROVED' AND EXISTS (SELECT 1 FROM extraction_run r WHERE r."submissionId" = NEW.id))
  ) THEN
    RAISE EXCEPTION 'DOC_STATE_ILLEGAL: COMMITTED without provenance (an APPROVE decision or the AUTO_APPROVED ledger)';
  END IF;

  NEW.status := COALESCE(doc_state_legacy_status(NEW.state), NEW.status);
  RETURN NEW;
END
$$;`,
    `DROP TRIGGER IF EXISTS verification_documents_doc_state ON verification_documents;`,
    `CREATE TRIGGER verification_documents_doc_state
BEFORE INSERT OR UPDATE ON verification_documents
FOR EACH ROW EXECUTE FUNCTION verification_documents_doc_state();`,
  ];
}

/** The schema half of the migration (enum, column, table) — hand-written once; the DDL above is regenerated. */
export const DOC_STATE_MIGRATION_HEADER = `-- [DOC-1 Part V · P5-1] The document state machine: 17 states, ONE transition table, enforced by trigger.
-- EXPAND: adds a column and a global table; legacy \`status\` becomes the projection of \`state\`.
CREATE TYPE "DocState" AS ENUM (${DOC_STATES.map(sqlLit).join(', ')});

ALTER TABLE "verification_documents" ADD COLUMN "state" "DocState";
CREATE INDEX "verification_documents_state_idx" ON "verification_documents"("state");

CREATE TABLE "doc_state_transition" (
    "fromState" "DocState" NOT NULL,
    "toState" "DocState" NOT NULL,
    "event" TEXT NOT NULL,
    "spec" TEXT NOT NULL,

    CONSTRAINT "doc_state_transition_pkey" PRIMARY KEY ("fromState","toState")
);

-- Backfill BEFORE the trigger exists: existing rows are judged by what they are, not by a transition.
UPDATE "verification_documents" d SET "state" = CASE
  WHEN d."purgedAt" IS NOT NULL THEN 'PURGED'::"DocState"
  WHEN d."status" = 'APPROVED' THEN 'COMMITTED'::"DocState"
  WHEN d."status" = 'REJECTED' THEN 'REJECTED'::"DocState"
  WHEN d."status" = 'EXPIRED' THEN 'EXPIRED'::"DocState"
  WHEN EXISTS (SELECT 1 FROM "review_case" c WHERE c."submissionId" = d."id" AND c."closedAt" IS NULL AND c."assignedTo" IS NOT NULL) THEN 'IN_REVIEW'::"DocState"
  ELSE 'REVIEW_QUEUED'::"DocState"
END
WHERE d."state" IS NULL;
`;
