// ---------------------------------------------------------------------------
// The safety operations console — decision logic, kept out of the component.
//
// 23 safety routes shipped with NO client. The full incident lifecycle (ack →
// investigate → decide → close, escalate-police, shadow-restrict, lift-interim)
// and the whole evidence chain of custody (view · seal · legal-hold · export)
// existed, were tested, and no screen anywhere let a human touch them. Swift
// could detect an incident, page ops, assemble and seal an evidence bundle,
// place a legal hold and prepare a police export — from nowhere.
//
// The reason is not neglect. The safety spec specified the engine; the Mission
// Control standing orders never mention safety, SOS, incidents or evidence at
// all. The console was never asked for a safety screen, so it never grew one.
//
// The pure decisions live here (mirroring lib/moderationView) so the rules can
// be graded without a DOM: which actions a case's status actually permits, when
// an SLA clock has run out, and whether a chain-of-custody reason is acceptable.
// ---------------------------------------------------------------------------

export type IncidentStatus = 'OPEN' | 'TRIAGED' | 'INVESTIGATING' | 'DECIDED' | 'CLOSED';
export type IncidentSeverity = 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
export type DecisionCode = 'DISMISSED' | 'WARNING_ISSUED' | 'SUSPENSION_PERMANENT' | 'RESOLVED_OTHER';

export const DECISION_CODES: DecisionCode[] = ['DISMISSED', 'WARNING_ISSUED', 'SUSPENSION_PERMANENT', 'RESOLVED_OTHER'];

/** The server's own state machine (incident.service.ts INCIDENT_TRANSITIONS).
 *  Restated here ONLY to grey out buttons; the server still refuses illegal
 *  moves. A console that offers an action the server will reject teaches the
 *  operator that the console lies — during an emergency, that is expensive. */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['TRIAGED'],
  TRIAGED: ['INVESTIGATING', 'DECIDED'],
  INVESTIGATING: ['DECIDED'],
  DECIDED: ['CLOSED'],
  CLOSED: [],
};

export interface IncidentRow {
  id: string;
  caseNumber: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  category: string;
  summary: string;
  subjectUserId: string;
  orderId: string | null;
  sosAlertId: string | null;
  escalatedPoliceAt: string | null;
  legalHold: boolean;
  interimAction: string;
  slaAckBy: string;
  slaDecideBy: string;
  ackedAt: string | null;
  decidedAt: string | null;
  closedAt: string | null;
  decisionCode: DecisionCode | null;
  createdAt: string;
}

export type IncidentAction =
  | 'ack' | 'investigate' | 'decide' | 'close'
  | 'escalate-police' | 'shadow-restrict' | 'lift-interim';

/**
 * Which actions this case can actually take right now.
 *
 * `ack` is NOT a transition — the server stamps `ackedAt` and moves OPEN →
 * TRIAGED, so it is offered only while unacknowledged. The three side actions
 * are not transitions either: police escalation, shadow restriction and
 * lifting an interim action all apply to a live case at any stage, which is why
 * each is gated on its own fact rather than on `status`.
 */
export function availableActions(c: IncidentRow): IncidentAction[] {
  if (c.status === 'CLOSED') {
    // A closed case can still be escalated to the police IF it already was —
    // the server refuses a NEW escalation on a closed case (CASE_CLOSED), and
    // offering it here would be a button that always errors.
    return [];
  }
  const out: IncidentAction[] = [];
  if (!c.ackedAt) out.push('ack');
  if (INCIDENT_TRANSITIONS[c.status].includes('INVESTIGATING')) out.push('investigate');
  if (INCIDENT_TRANSITIONS[c.status].includes('DECIDED')) out.push('decide');
  if (INCIDENT_TRANSITIONS[c.status].includes('CLOSED')) out.push('close');
  if (!c.escalatedPoliceAt) out.push('escalate-police');
  if (c.interimAction === 'NONE') out.push('shadow-restrict');
  else out.push('lift-interim');
  return out;
}

export type SlaState = 'ok' | 'due' | 'breached' | 'met';

export interface SlaClock {
  label: string;
  state: SlaState;
  /** Minutes remaining; negative once the deadline has passed. */
  minutes: number;
}

/**
 * An SLA clock reads from the DEADLINE and the stamp that stops it, never from
 * status. A case can sit in TRIAGED with its decide clock already blown.
 *
 * `due` is the last 25% of nothing — it is a fixed 15-minute warning, because
 * an S0's whole ack window is five minutes and a percentage of that is not a
 * warning, it is a rounding error.
 */
export function slaClock(label: string, deadlineIso: string, stoppedAtIso: string | null, now = new Date()): SlaClock {
  const deadline = new Date(deadlineIso).getTime();
  const minutes = Math.round((deadline - now.getTime()) / 60_000);
  if (stoppedAtIso) {
    // Met or missed, but it is over either way — a stopped clock never nags.
    return { label, state: 'met', minutes };
  }
  if (minutes < 0) return { label, state: 'breached', minutes };
  if (minutes <= 15) return { label, state: 'due', minutes };
  return { label, state: 'ok', minutes };
}

export function clocksFor(c: IncidentRow, now = new Date()): SlaClock[] {
  return [
    slaClock('Ack', c.slaAckBy, c.ackedAt, now),
    slaClock('Decide', c.slaDecideBy, c.decidedAt, now),
  ];
}

/** The worst state across a case's clocks — what the row's stripe shows. */
export function worstSla(c: IncidentRow, now = new Date()): SlaState {
  const states = clocksFor(c, now).map((k) => k.state);
  if (states.includes('breached')) return 'breached';
  if (states.includes('due')) return 'due';
  if (states.every((s) => s === 'met')) return 'met';
  return 'ok';
}

/** Severity-first, then oldest — the server's own queue order, so the console
 *  shows the same queue the API paginates rather than a second opinion. */
export function queueOrder(rows: IncidentRow[]): IncidentRow[] {
  return [...rows].sort((a, b) =>
    a.severity.localeCompare(b.severity)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    || a.id.localeCompare(b.id),
  );
}

// ── Evidence: chain of custody ─────────────────────────────────────────────

/** The server demands 5–1000 characters (`reasonBody`). Mirrored so the button
 *  is disabled rather than the request rejected — but see `REASON_PLACEHOLDERS`:
 *  a length check alone is what lets "asdfg" into a court exhibit's audit log. */
export const REASON_MIN = 5;
export const REASON_MAX = 1000;

/** Strings that satisfy the length rule and say nothing. Every evidence access
 *  writes a SafetyAccessLog row that a court may one day read; "test", "n/a"
 *  and a row of keyboard mash are not reasons, and the moment to catch them is
 *  before the log is written, not in a review afterwards. */
const REASON_PLACEHOLDERS = [
  'test', 'testing', 'asdf', 'asdfg', 'qwerty', 'n/a', 'na', 'none', 'reason',
  'check', 'checking', 'because', 'tmp', 'temp', 'xxxxx', '.....',
];

export function reasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN) return `A reason of at least ${REASON_MIN} characters is recorded against your name.`;
  if (trimmed.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  const flat = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (REASON_PLACEHOLDERS.includes(flat)) return 'That will be read back in an investigation. Say why you are opening this.';
  if (new Set(flat).size <= 2) return 'That will be read back in an investigation. Say why you are opening this.';
  return null;
}

export const reasonAccepted = (reason: string): boolean => reasonProblem(reason) === null;

export interface EvidenceBundleRow {
  id: string;
  bundleNumber: string;
  sosAlertId: string | null;
  caseId: string | null;
  subjectUserId: string | null;
  openedAt: string;
  sealedAt: string | null;
  sealHash: string | null;
  legalHold: boolean;
  _count: { items: number };
}

export type EvidenceAction = 'view' | 'seal' | 'legal-hold' | 'export';

/**
 * Sealing is IRREVERSIBLE — Postgres triggers refuse mutation afterwards — so
 * it is offered once and never again. Everything else stays available on a
 * sealed bundle: a sealed bundle is exactly what gets exported to the police,
 * and a legal hold on an already-sealed bundle is the ordinary case.
 */
export function evidenceActions(b: EvidenceBundleRow): EvidenceAction[] {
  const out: EvidenceAction[] = ['view'];
  if (!b.sealedAt) out.push('seal');
  if (!b.legalHold) out.push('legal-hold');
  out.push('export');
  return out;
}

/** What the operator is told before they seal. Sealing is not undoable and the
 *  console should say so in words, not in a disabled state they discover. */
export const SEAL_WARNING =
  'Sealing stamps every item and computes the bundle hash. After that the database itself refuses any change — this cannot be undone.';

export const EXPORT_WARNING =
  'The export is encrypted and watermarked, and the passphrase is shown exactly once. Swift keeps no copy — hand it over on a separate channel.';

// ── SOS ────────────────────────────────────────────────────────────────────

export type SosStatus = 'TRIGGER_PENDING' | 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED' | 'CANCELLED';
export type SosResolutionCode = 'SAFE' | 'FALSE_ALARM' | 'ABUSE' | 'POLICE_INVOLVED' | 'UNREACHABLE';

export const SOS_RESOLUTION_CODES: SosResolutionCode[] = ['SAFE', 'FALSE_ALARM', 'ABUSE', 'POLICE_INVOLVED', 'UNREACHABLE'];

export interface SosRow {
  id: string;
  actorUserId: string;
  actorRole: string;
  status: SosStatus;
  orderId: string | null;
  triggeredAt: string;
  triggerSource: string;
  triggerLat: number | null;
  triggerLng: number | null;
  triggerAddressText: string | null;
  userSafeFlaggedAt: string | null;
  acknowledgedAt: string | null;
  retriggerCount: number;
}

/**
 * "I'm safe" is NOT a resolution.
 *
 * The schema states the doctrine on the column itself: `userSafeFlaggedAt` —
 * "NEVER auto-resolves; a human must (coercion doctrine)". A person under
 * duress can be made to tap it. The console must therefore show the flag
 * PROMINENTLY and must never let it dim the alert, which is the natural thing
 * a queue does with a row that looks handled.
 */
export function sosNeedsHuman(a: SosRow): boolean {
  return a.status !== 'RESOLVED' && a.status !== 'CANCELLED';
}

export function sosUrgency(a: SosRow, now = new Date()): 'critical' | 'high' | 'watch' {
  if (a.status === 'ACTIVE' && !a.acknowledgedAt) return 'critical';
  if (a.retriggerCount > 0) return 'critical';
  if (a.status === 'TRIGGER_PENDING') return 'high';
  const mins = (now.getTime() - new Date(a.triggeredAt).getTime()) / 60_000;
  return mins > 30 ? 'high' : 'watch';
}

export const pretty = (s: string): string => s.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── Raising a case by hand ─────────────────────────────────────────────────

/**
 * The categories, and the severity each one defaults to (incident.service.ts
 * CATEGORY_SEVERITY). The console shows the default so an operator taking a
 * phone call sees the SLA they are committing to before they commit to it —
 * an S0 is a five-minute ack clock, and picking the category is what starts it.
 * Severity stays overridable, which is the server's own rule.
 */
export const INCIDENT_CATEGORIES: Array<{ code: string; severity: IncidentSeverity }> = [
  { code: 'SAFETY_ASSAULT', severity: 'S0' },
  { code: 'SAFETY_THREAT', severity: 'S1' },
  { code: 'IDENTITY_MISMATCH', severity: 'S1' },
  { code: 'MOVER_SESSION_LOST_IN_CUSTODY', severity: 'S1' },
  { code: 'SAFETY_HARASSMENT', severity: 'S2' },
  { code: 'DRIVING_DANGEROUS', severity: 'S2' },
  { code: 'CASH_DISPUTE', severity: 'S3' },
  { code: 'COMPLETION_ANOMALY', severity: 'S3' },
  { code: 'SERVICE_QUALITY', severity: 'S4' },
  { code: 'OTHER', severity: 'S3' },
];

export const SEVERITIES: IncidentSeverity[] = ['S0', 'S1', 'S2', 'S3', 'S4'];

export function defaultSeverityFor(category: string): IncidentSeverity {
  return INCIDENT_CATEGORIES.find((c) => c.code === category)?.severity ?? 'S3';
}

export interface IntakeDraft {
  subjectUserId: string;
  category: string;
  severity: IncidentSeverity | '';
  summary: string;
  orderId: string;
}

/** The server's own bounds, mirrored so the button disables instead of the
 *  request failing — a case raised during a phone call should not bounce. */
export function intakeProblem(d: IntakeDraft): string | null {
  if (!d.subjectUserId.trim()) return 'Name who the case is about.';
  if (!d.category) return 'Pick a category — it sets the SLA clock.';
  if (d.summary.trim().length < 5) return 'Summarise what happened in at least 5 characters.';
  if (d.summary.trim().length > 2000) return 'Keep the summary under 2000 characters.';
  return null;
}
