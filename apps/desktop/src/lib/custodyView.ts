/**
 * [DOC-1 §20.2 · P20-2 · S5] The chain-of-custody narrative, shaped for the Review Center: the
 * server's read model in, display lines out. Pure — the panel decides nothing.
 */
export interface CustodyEvent { at: string; actor: string | null; what: string; detail?: Record<string, unknown> }
export interface CustodyNarrative {
  submission: { id: string; docType: string; role: string; accountId: string; subjectId: string | null; state: string; status: string; capturedAt: string; purgedAt: string | null; imagePurgedAt: string | null; legalHoldId: string | null };
  capture: { sha256: string | null; sizeBytes: number | null; mimeType: string | null; encrypted: boolean; shreddedAt: string | null; deviceAndLocation: string };
  extraction: Array<{ runId: string; engine: string; engineVersion: string; outcome: string; errorClass: string | null; ranExternally: boolean; fields: Array<{ code: string; present: boolean; illegible: boolean }> }>;
  validations: Array<{ code: string; status: string; detailCode: string | null; blocking: boolean }>;
  destruction: Array<{ at: string; by: string; stores: string[]; bytesDeleted: number; probe: string }>;
  audit: { entries: CustodyEvent[]; chain: { anchoredAt: string | null; anchoredHeadSeq: string | null; anchorVerified: boolean | null } };
  timeline: CustodyEvent[];
  provable: string[];
  notProvable: string[];
  generatedAt: string;
}

export interface TimelineLine { at: string; when: string; actor: string; what: string; tone: 'neutral' | 'good' | 'bad' | 'evidence' }

const TONE: Array<[RegExp, TimelineLine['tone']]> = [
  [/^DESTROYED|^SUBMISSION PURGED|^IMAGE PURGED/, 'evidence'],
  [/FAIL|REJECT|REVOKED|EXPIRED|OUTAGE/, 'bad'],
  [/PASS|APPROVE|RECORD VALID|COMMITTED/, 'good'],
];
export function timelineLines(n: Pick<CustodyNarrative, 'timeline'>): TimelineLine[] {
  return n.timeline.map((e) => ({
    at: e.at,
    when: new Date(e.at).toLocaleString(),
    actor: e.actor ?? '—',
    what: e.what,
    tone: TONE.find(([re]) => re.test(e.what))?.[1] ?? 'neutral',
  }));
}

/** One sentence the reviewer can read out to a vendor who says Swift "lost" their document. */
export function custodySummary(n: CustodyNarrative): string {
  const destroyed = n.destruction.length > 0;
  const chain = n.audit.chain.anchorVerified === true ? 'the audit chain is anchored and verified' : n.audit.chain.anchoredAt ? 'the audit chain is anchored' : 'the audit chain has no anchor yet';
  return `${n.submission.docType.replace(/_/g, ' ')} submitted ${new Date(n.submission.capturedAt).toLocaleString()} by account ${n.submission.accountId}; ` +
    `${n.extraction.length} extraction run${n.extraction.length === 1 ? '' : 's'}, ${n.validations.length} verdict${n.validations.length === 1 ? '' : 's'}; ` +
    `status ${n.submission.status}${destroyed ? `; bytes destroyed (${n.destruction.map((d) => d.probe).join(', ')})` : ''}; ${chain}.`;
}

/** What the record can and cannot prove — §20.3, verbatim from the server. */
export function proofLists(n: Pick<CustodyNarrative, 'provable' | 'notProvable'>): { provable: string[]; notProvable: string[] } {
  return { provable: [...n.provable], notProvable: [...n.notProvable] };
}
