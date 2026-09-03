// ---------------------------------------------------------------------------
// CLOSING A CHILD-SAFETY REPORT.
//
// Swift's own published child-safety standards say, in as many words:
//
//   "Confirmed material is removed, the account is banned, and we report to the
//    relevant authorities and, where applicable, to recognised child-protection
//    bodies such as NCMEC, as the law requires. We preserve evidence needed for
//    those reports."                        — legal.routes.ts, /child-safety
//
// Nothing in the system recorded any of that, or required it. A CSAE report
// closed exactly like a spam report: one click to ACTIONED or DISMISSED, with
// an OPTIONAL free-text note. "Handled" and "nobody looked properly" produced
// identical rows, and the platform could not show — to a regulator, an app
// store, or itself — that the promise above had been kept even once.
//
// So a CSAE closure now has to say WHAT was decided, in a coded disposition,
// and carry the evidence that disposition implies. Ordinary moderation is
// deliberately untouched: a spam report does not need a case file, and
// requiring one would push operators to mislabel reports to get through the
// queue, which is worse than the problem.
//
// DUAL CONTROL, on dismissal only. Deciding a child-safety report is NOT a
// violation is the highest-consequence "nothing happened" decision the platform
// can make, and it is the one an overloaded queue produces by accident. It
// takes two people: one proposes, a DIFFERENT one confirms. Acting on a report
// stays one click, because the failure mode there is acting too slowly.
// ---------------------------------------------------------------------------

/** What was decided, from a fixed set — never free text. */
export type CsaeDisposition =
  /** The material was removed and/or the account was actioned. */
  | 'ENFORCED'
  /** Enforced AND reported to an authority or child-protection body. */
  | 'ENFORCED_AND_REPORTED'
  /** Reviewed against the policy and found not to be a violation. */
  | 'NO_VIOLATION'
  /** The same content/account is already covered by another open case. */
  | 'DUPLICATE';

export const CSAE_DISPOSITIONS: CsaeDisposition[] = [
  'ENFORCED', 'ENFORCED_AND_REPORTED', 'NO_VIOLATION', 'DUPLICATE',
];

/** Which dispositions close a report as ACTIONED, and which as DISMISSED. */
const ACTIONING: CsaeDisposition[] = ['ENFORCED', 'ENFORCED_AND_REPORTED'];

export interface CsaeClosure {
  /** The status being written. */
  status: string;
  disposition?: string | null;
  /** What was done, referenced: the removed content's id, the banned account. */
  enforcementRef?: string | null;
  /** The reference of the report made to an authority / child-protection body. */
  authorityRef?: string | null;
  /** Whether the evidence needed for that report has been preserved. */
  evidencePreserved?: boolean | null;
  /** Who proposed a dismissal, if one has been proposed. */
  dismissProposedBy?: string | null;
  /** Who is closing it now. */
  actorId: string;
}

/** Every way a CSAE closure is not yet a closure. Empty means it may proceed. */
export function csaeClosureProblems(c: CsaeClosure): string[] {
  const problems: string[] = [];
  const closing = c.status === 'ACTIONED' || c.status === 'DISMISSED';
  if (!closing) return problems;

  const disposition = c.disposition as CsaeDisposition | null | undefined;
  if (!disposition || !CSAE_DISPOSITIONS.includes(disposition)) {
    problems.push('a child-safety report closes with a coded disposition, not a note');
    return problems; // everything below depends on knowing what was decided
  }

  const actioning = ACTIONING.includes(disposition);
  if (c.status === 'ACTIONED' && !actioning) {
    problems.push(`"${disposition}" is not an enforcement outcome — dismiss it instead, with a second reviewer`);
  }
  if (c.status === 'DISMISSED' && actioning) {
    problems.push(`"${disposition}" says enforcement happened — record it as actioned`);
  }

  if (actioning) {
    // What was actually done, referenced. Without this "ENFORCED" is a word.
    if (!c.enforcementRef || c.enforcementRef.trim().length < 3) {
      problems.push('name what was enforced — the content removed or the account actioned');
    }
    // The standards page promises preservation for anything confirmed.
    if (!c.evidencePreserved) {
      problems.push('confirm the evidence has been preserved — the child-safety standards promise it');
    }
  }
  if (disposition === 'ENFORCED_AND_REPORTED' && (!c.authorityRef || c.authorityRef.trim().length < 3)) {
    problems.push('name the report made to the authority or child-protection body');
  }

  // Dual control: a dismissal takes two people, and not the same one twice.
  if (c.status === 'DISMISSED') {
    if (!c.dismissProposedBy) {
      problems.push('a child-safety dismissal is proposed first, then confirmed by a second reviewer');
    } else if (c.dismissProposedBy === c.actorId) {
      problems.push('the second reviewer must be a different person from the one who proposed the dismissal');
    }
  }
  return problems;
}
