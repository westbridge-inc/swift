import { ENUM_LABELS, humanise } from '@/lib/labels';

// ---------------------------------------------------------------------------
// [SAFETY BOARD] What the web console's Safety page decides, kept out of the component. Copied from the desktop console's
// lib/safetyView.ts, with these differences on purpose:
//   - the resolution codes are the server's (the desktop list offers two the route refuses);
//   - an SOS offers only the moves its status allows (the grace window allows neither);
//   - a closed case still offers the lift when its hold is on: the server takes it, and nothing else clears the stamp;
//   - the position is the newest one with its accuracy, and "no open SOS" needs a recent read.
// The rules are restated here ONLY to stop offering what would be refused: the server decides again, and
// safetyView.test.ts reads the server's source, so a change there turns this red.
// ---------------------------------------------------------------------------

export type SosStatus = keyof typeof ENUM_LABELS.SosStatus;
export type SosResolutionCode = keyof typeof ENUM_LABELS.SosResolutionCode;
export type IncidentStatus = keyof typeof ENUM_LABELS.IncidentStatus;
export type IncidentSeverity = 'S0' | 'S1' | 'S2' | 'S3' | 'S4';
export type CaseScope = 'open' | 'breached' | 'all';

export const SOS_RESOLUTION_CODES = Object.keys(ENUM_LABELS.SosResolutionCode) as SosResolutionCode[];

/** The server's own state machine (sos.service.ts). "I'm safe" is not on it: only a person here closes an alert. */
export const SOS_TRANSITIONS: Record<SosStatus, SosStatus[]> = {
  TRIGGER_PENDING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ACKNOWLEDGED', 'RESOLVED'],
  ACKNOWLEDGED: ['RESOLVED'],
  RESOLVED: [],
  CANCELLED: [],
};

/** The server's own state machine (incident.service.ts). */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['TRIAGED'],
  TRIAGED: ['INVESTIGATING', 'DECIDED'],
  INVESTIGATING: ['DECIDED'],
  DECIDED: ['CLOSED'],
  CLOSED: [],
};

/** The server's decision codes, in its order, in the console's words. */
export const DECISION_WORDS = {
  DISMISSED: 'Dismissed',
  WARNING_ISSUED: 'Warning issued',
  SUSPENSION_PERMANENT: 'Permanent suspension',
  RESOLVED_OTHER: 'Resolved another way',
} as const;
export type DecisionCode = keyof typeof DECISION_WORDS;

const CATEGORY_WORDS: Record<string, string> = {
  SAFETY_ASSAULT: 'Assault',
  SAFETY_THREAT: 'Threat',
  IDENTITY_MISMATCH: 'Wrong person or vehicle',
  MOVER_SESSION_LOST_IN_CUSTODY: 'Rider’s session ended while holding goods',
  SAFETY_HARASSMENT: 'Harassment',
  DRIVING_DANGEROUS: 'Dangerous driving',
  CASH_DISPUTE: 'Cash dispute',
  COMPLETION_ANOMALY: 'Completion looks wrong',
  SERVICE_QUALITY: 'Service quality',
  OTHER: 'Other',
};
export const categoryWords = (category: string): string => CATEGORY_WORDS[category] ?? humanise(category);

const INTERIM_WORDS: Record<string, { words: string; noun: string }> = {
  SUSPENDED_PENDING_REVIEW: { words: 'Suspended pending review', noun: 'suspension' },
  SHADOW_RESTRICTED: { words: 'Restricted pending review', noun: 'restriction' },
};
/** The hold a case keeps on a person, in words; null when it keeps none. */
export function interimWords(c: Pick<IncidentRow, 'interimAction'>): { words: string; noun: string } | null {
  if (c.interimAction === 'NONE') return null;
  return INTERIM_WORDS[c.interimAction] ?? { words: humanise(c.interimAction), noun: 'hold' };
}

/** One repeat press as the server keeps it on the alert: an entry from before notes has no `note`. */
export interface SosRetrigger {
  seq: number;
  at: string;
  note?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  addressText?: string | null;
}

export interface SosRow {
  id: string;
  actorUserId: string;
  actorRole: string;
  status: SosStatus;
  orderId: string | null;
  orderType: string | null;
  serviceJobId: string | null;
  counterpartyUserId: string | null;
  triggeredAt: string;
  graceEndsAt?: string | null;
  triggerSource: string;
  triggerLat: number | null;
  triggerLng: number | null;
  triggerAccuracyM: number | null;
  triggerAddressText: string | null;
  triggerNote: string | null;
  retriggers: SosRetrigger[] | null;
  userSafeFlaggedAt: string | null;
  acknowledgedAt: string | null;
  retriggerCount: number;
}

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

export type SosAction = 'ack' | 'resolve';
export type CaseAction = 'ack' | 'decide' | 'close' | 'lift-interim';

export function sosActions(a: SosRow): SosAction[] {
  const next = SOS_TRANSITIONS[a.status] ?? [];
  const out: SosAction[] = [];
  if (next.includes('ACKNOWLEDGED')) out.push('ack');
  if (next.includes('RESOLVED')) out.push('resolve');
  return out;
}

export function caseActions(c: IncidentRow): CaseAction[] {
  const next = INCIDENT_TRANSITIONS[c.status] ?? [];
  const out: CaseAction[] = [];
  if (next.includes('TRIAGED')) out.push('ack');
  if (next.includes('DECIDED')) out.push('decide');
  if (next.includes('CLOSED')) out.push('close');
  if (c.interimAction !== 'NONE') out.push('lift-interim');
  return out;
}

/** The grace window ran out and the last read still has it not live: normally the next read shows it live, and if it does not, nobody was paged. */
export const sosGraceOver = (a: SosRow, now: number): boolean =>
  a.status === 'TRIGGER_PENDING' && !!a.graceEndsAt && new Date(a.graceEndsAt).getTime() <= now;

/** Nobody has this alert yet, the person pressed again, or the page never went out: the board marks it. */
export const sosNeedsYou = (a: SosRow, now: number): boolean =>
  (a.status === 'ACTIVE' && !a.acknowledgedAt) || a.retriggerCount > 0 || sosGraceOver(a, now);

export interface SosNote {
  /** 0 = the press that raised the alert; n = the n-th repeat press. */
  seq: number;
  at: string;
  text: string;
}

const repeats = (a: SosRow): SosRetrigger[] => (Array.isArray(a.retriggers) ? a.retriggers : []);

/** What the person said, oldest first, kept exactly (trimmed, never cut or rewritten). A press with no words is no message. */
export function sosNotes(a: SosRow): SosNote[] {
  const out: SosNote[] = [];
  const first = typeof a.triggerNote === 'string' ? a.triggerNote.trim() : '';
  if (first) out.push({ seq: 0, at: a.triggeredAt, text: first });
  for (const r of repeats(a)) {
    const text = typeof r?.note === 'string' ? r.note.trim() : '';
    if (text) out.push({ seq: typeof r.seq === 'number' ? r.seq : Number.MAX_SAFE_INTEGER, at: typeof r.at === 'string' ? r.at : a.triggeredAt, text });
  }
  return out.sort((x, y) => x.seq - y.seq);
}

/** The alert's count is the truth; the summary keeps only the newest presses. */
export const sosPressesNotShown = (a: SosRow): number => Math.max(0, (a.retriggerCount ?? 0) - repeats(a).length);

const place = (addressText: string | null | undefined, lat: number | null | undefined, lng: number | null | undefined, accuracyM: number | null | undefined): SosPlace | null => {
  const measured = typeof accuracyM === 'number' && Number.isFinite(accuracyM) ? `±${Math.round(accuracyM)} m` : null;
  const address = typeof addressText === 'string' ? addressText.trim() : '';
  if (address) return { text: address, accuracy: measured };
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { text: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, accuracy: measured ?? 'Accuracy not reported' };
};

export interface SosPlace {
  text: string;
  /** "±900 m": five decimals alone read as an exact point, and an indoor fix is not one. */
  accuracy: string | null;
}

/**
 * Where they are, as far as the server knows: the newest press that carried a position, else the alert's own. There is no
 * "first position" to show beside it: a repeat press with coordinates overwrites the alert's own (sos.service.ts), so the row
 * holds the latest one and printing it as the first would say they have not moved.
 */
export function sosPosition(a: SosRow): (SosPlace & { seq?: number; at?: string }) | null {
  let newest: (SosPlace & { seq: number; at: string }) | null = null;
  for (const r of repeats(a)) {
    const found = place(r?.addressText, r?.lat, r?.lng, r?.accuracyM);
    if (found) newest = { ...found, seq: r.seq, at: r.at };
  }
  return newest ?? place(a.triggerAddressText, a.triggerLat, a.triggerLng, a.triggerAccuracyM);
}

/** "No open SOS." is said only on a read under this old. Three polls: one missed read is not an alarm, a silent board is. */
export const SOS_READ_FRESH_MS = 45_000;
export const sosReadFresh = (readAt: number, now: number): boolean => readAt > 0 && now >= readAt && now - readAt < SOS_READ_FRESH_MS;

export type SlaState = 'ok' | 'due' | 'breached' | 'met';

export interface SlaClock {
  label: string;
  deadline: string;
  state: SlaState;
  /** Minutes remaining; negative once the deadline has passed. */
  minutes: number;
}

/** A clock reads from the deadline and the stamp that stops it, never from status. `due` is a fixed 15 minutes: an S0's
 *  whole acknowledgement window is five. */
export function slaClock(label: string, deadline: string, stoppedAt: string | null, now = new Date()): SlaClock {
  const minutes = Math.round((new Date(deadline).getTime() - now.getTime()) / 60_000);
  if (stoppedAt) return { label, deadline, state: 'met', minutes };
  if (minutes < 0) return { label, deadline, state: 'breached', minutes };
  return { label, deadline, state: minutes <= 15 ? 'due' : 'ok', minutes };
}

export const clocksFor = (c: IncidentRow, now = new Date()): SlaClock[] => [
  slaClock('Acknowledge by', c.slaAckBy, c.ackedAt, now),
  slaClock('Decide by', c.slaDecideBy, c.decidedAt, now),
];

export function worstSla(c: IncidentRow, now = new Date()): SlaState {
  const states = clocksFor(c, now).map((k) => k.state);
  if (states.includes('breached')) return 'breached';
  if (states.includes('due')) return 'due';
  return states.every((s) => s === 'met') ? 'met' : 'ok';
}

/** Severity first, then newest, then id: the order the server pages in. */
export function queueOrder(rows: IncidentRow[]): IncidentRow[] {
  return [...rows].sort((a, b) =>
    a.severity.localeCompare(b.severity)
    || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    || a.id.localeCompare(b.id));
}
