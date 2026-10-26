/**
 * [DOC-CONSENT · owner 25 Oct 2026] The document-upload tick the person already gave, as the server's ledger holds it.
 *
 * The checklist's tick (lib/uploadConsentCopy DOCUMENT_CONSENT_TEXT) is recorded in the consent ledger with every
 * upload (hooks/verification sends `consentTick: 'document_v1'`). GET /verification/status returns
 * `documentConsent` = { tick, given, givenAt }: `given` only when this person's latest ledger row for these exact
 * words is their grant. The checklist shows the box ticked from it, so a new visit no longer empties a tick the
 * person gave. Anything else — no field (an older API), another tick's words, `given` not exactly true — is "not
 * on record" and the box starts empty: nothing is ever ticked for anyone.
 */

/** The tick this checklist shows and every upload sends (the API's UPLOAD_CONSENT key for these words). */
export const DOCUMENT_CONSENT_TICK = 'document_v1';

export type DocumentConsentRecord = { given: boolean; givenAt: string | null };

const NOT_ON_RECORD: DocumentConsentRecord = { given: false, givenAt: null };

export function documentConsentOnRecord(status: unknown): DocumentConsentRecord {
  const record = status && typeof status === 'object' ? (status as { documentConsent?: unknown }).documentConsent : undefined;
  if (!record || typeof record !== 'object') return NOT_ON_RECORD;
  const { tick, given, givenAt } = record as { tick?: unknown; given?: unknown; givenAt?: unknown };
  if (tick !== DOCUMENT_CONSENT_TICK || given !== true) return NOT_ON_RECORD;
  return { given: true, givenAt: typeof givenAt === 'string' && !Number.isNaN(Date.parse(givenAt)) ? givenAt : null };
}

/** Under a tick shown from the record: it is the person's own, and when they gave it — the day in Guyana, like the
 *  other partner dates (lib/weeklyFee), whatever zone the phone is set to. */
export function documentConsentGivenLine(givenAt: string | null): string {
  if (!givenAt) return 'You ticked this before.';
  const on = new Date(givenAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guyana' });
  return `You ticked this on ${on}.`;
}

/**
 * [DPA s.9(1)(a) · legal research D1] Sensitive documents: a criminal record. The record alone never opens one —
 * when the tick on screen came only from the record, the card asks for the consent again before the photo.
 */
export const SENSITIVE_DOC_TYPES: ReadonlySet<string> = new Set(['police_clearance']);

/** What the card says above the consent words when it asks again. */
export const SENSITIVE_CONSENT_ASK = 'A police clearance is sensitive, so Swift asks again before this upload.';

/**
 * [POLICE-CLEARANCE CONSENT · DPA s.9(1)(a), legal research D1/D2] A police clearance's OWN consent, in the API's
 * words (GET /verification/status `policeClearanceConsent`): they say what is true right now (what Swift records,
 * when the image goes, the withdrawal), so the phone never bakes them in — it shows them, sends their version, and
 * the API refuses words that changed. Anything malformed, or an older API with none, is "no words": the card then
 * keeps the document tick and the ask above, exactly as before.
 */
export const POLICE_CLEARANCE_TICK = 'police_clearance_v1';
export type PoliceClearanceWords = { tick: typeof POLICE_CLEARANCE_TICK; version: string; text: string; withdrawConfirm: string };

const filled = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function policeClearanceWordsFrom(status: unknown): PoliceClearanceWords | null {
  const words = status && typeof status === 'object' ? (status as { policeClearanceConsent?: unknown }).policeClearanceConsent : undefined;
  if (!words || typeof words !== 'object') return null;
  const { tick, version, text, withdrawConfirm } = words as Record<string, unknown>;
  if (tick !== POLICE_CLEARANCE_TICK || !filled(version, 40) || !filled(text, 2000) || !filled(withdrawConfirm, 500)) return null;
  return { tick: POLICE_CLEARANCE_TICK, version, text, withdrawConfirm };
}
