// [DRILL-STORM · S-19] The words of a responder's page on the phone. Pure, so
// they are tested without a renderer.

export type OpsAlertKind = 'SOS' | 'DRILL' | 'PLATFORM';
export interface OpsAlertRow {
  id: string;
  kind: OpsAlertKind;
  title: string;
  body: string;
  createdAt: string;
  ackDeadlineAt: string;
  escalationLevel: number;
}

const KIND_WORDS: Record<OpsAlertKind, string> = { SOS: 'SOS', DRILL: 'Drill', PLATFORM: 'Operations page' };
/** The kind in words; anything the phone does not know reads as an operations page, never a code. */
export const kindWords = (kind: string): string => KIND_WORDS[kind as OpsAlertKind] ?? KIND_WORDS.PLATFORM;

/** "25 Oct, 12:35 pm" in Guyana time, plain ASCII (newer ICU puts a narrow space before am/pm). */
export function guyanaTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = at.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short' });
  const time = at.toLocaleTimeString('en-US', { timeZone: 'America/Guyana', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(/\s/g, ' ');
  return `${day}, ${time}`;
}

/** One line under the title: when it opened, its deadline or how long it is overdue, how often it was re-paged. */
export function alertLine(row: OpsAlertRow, now: number): string {
  const overdue = new Date(row.ackDeadlineAt).getTime() <= now;
  const parts = [`${kindWords(row.kind)} · opened ${guyanaTime(row.createdAt)}`, overdue ? 'overdue' : `acknowledge by ${guyanaTime(row.ackDeadlineAt)}`];
  if (row.escalationLevel > 0) parts.push(`re-paged ${row.escalationLevel} ${row.escalationLevel === 1 ? 'time' : 'times'}`);
  return parts.join(' · ');
}

/** The page the person tapped first, then SOS pages, then the oldest. */
export function inScreenOrder(rows: OpsAlertRow[], focusId?: string | null): OpsAlertRow[] {
  const rank = (r: OpsAlertRow) => (r.id === focusId ? 0 : r.kind === 'SOS' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Why the list could not be shown, from the server's answer. */
export function refusalOf(error: unknown): 'not-a-responder' | 'signed-out' | 'failed' {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 403) return 'not-a-responder';
  if (status === 401) return 'signed-out';
  return 'failed';
}
