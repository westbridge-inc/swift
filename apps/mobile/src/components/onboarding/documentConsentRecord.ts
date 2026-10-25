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
