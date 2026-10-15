import { fetchVerificationQueue } from './api';
import { isRejectionReasonCode, rejectionLabel } from './rejection-reasons';

export const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewLane = 'operator' | 'customer' | 'all';
/**
 * [MC-AD1] The applicant's latest earlier decision on the same document type, carried by each queue row
 * (GET /admin/verification/queue). Null: a first upload, or the lookup was unavailable — never an error.
 */
export interface PreviousDecision {
  documentId: string;
  kind: 'RESUBMITTED_AFTER_REJECTION' | 'RENEWAL';
  status: 'REJECTED' | 'EXPIRED' | 'APPROVED';
  /** The reviewer's own words to the applicant last time. */
  reviewNote: string | null;
  decidedAt: string | null;
  submittedAt: string;
}
export interface ReviewDocument {
  id: string; userId: string; docType: string; role: string; status: ReviewStatus;
  createdAt?: string; consentAt?: string | null; privacyNoticeVersion?: string | null;
  expiresAt?: string | null;
  previousDecision?: PreviousDecision | null;
  reviewerTypes?: Array<'documentNumber' | 'issuedOn'>;
  /** A reviewer's id, or the server's automatic marker ('auto:id-on-file', 'kyc:auto') — never shown raw. */
  reviewedBy?: string | null;
  user?: {
    id: string; firstName?: string; lastName?: string; phone?: string; countryCode?: string;
    driver?: { licensePlate?: string; vehicleMake?: string; vehicleModel?: string; vehicleType?: string } | null;
  };
}
export interface Applicant { id: string; name: string; phone: string; documents: ReviewDocument[]; oldest: number }
// Shared vocabulary for the queue, facts, dialogs and custody timeline.
const LABELS: Record<string, string> = {
  national_id: 'National ID', owner_national_id: 'National ID', passport: 'Passport', identity_l2: 'Customer ID',
  drivers_licence: "Driver's licence", gra_restaurant_licence: 'GRA restaurant licence',
  business_registration: 'Business registration', police_clearance: 'Police clearance',
  fitness_cert: 'Vehicle fitness certificate', vehicle_insurance: 'Vehicle insurance',
  hire_car_permit: 'Hire car permit', road_service_licence: 'Road service licence',
  hire_car_driver_licence: "Hire Car Driver's Licence", hire_car_vehicle_licence: "Car's hire licence (yearly)",
  food_handler_cert: 'Food handler certificate', vehicle_registration: 'Vehicle registration',
  liquor_licence: 'Liquor licence', sanitary_certificate: 'Sanitary certificate',
  trade_licence: 'Trade licence', tin_certificate: 'TIN certificate', pharmacy_authorisation: 'Pharmacy authorisation',
  nis_employer_reg: 'NIS employer registration', digital_id: 'Guyana digital ID',
  self_declaration_unregistered: 'Unregistered business declaration',
  // [MC-PR2] checklist photo types the queue and the activation checklist both name
  storefront_photo: 'Storefront photo', vehicle_plate_photo: 'Number-plate photo', vehicle_exterior_photo: 'Vehicle photo',
  // [TRADES · 13 Oct 2026] service-trade documents
  pest_control_operator_licence: 'PTCCB pest-control operator licence', pesticide_applicator_certificate: 'PTCCB applicator certificate',
  chartered_accountant_practising_certificate: 'ICAG practising certificate', gra_practice_certificate: 'GRA practice certificate',
  eating_house_registration: 'Eating-house registration', town_clerk_registration: 'Town Clerk registration',
  town_clerk_shop_certificate: 'Town Clerk shop certificate', drone_authorisation: 'GCAA drone authorisation',
  gei_electrical_licence: 'GEI electrical licence',
  VENDOR_OWNER: 'Business owner', MOVER: 'Rider/Driver', CUSTOMER: 'Customer',
  RIDER: 'Rider', DRIVER: 'Driver', ADMIN: 'Administrator',
  CAR: 'Car', MOTORCYCLE: 'Motorcycle', BICYCLE: 'Bicycle', VAN: 'Van', TRUCK: 'Truck',
  V_PLATE_CLASS: 'Plate class check', V_PLATE_FORMAT: 'Plate format check',
  V_NOT_EXPIRED: 'Expiry check', V_EXPIRY_PLAUSIBLE: 'Expiry check',
  V_LICENCE_CLASS: 'Licence class check', V_INSURANCE_SCOPE: 'Insurance coverage check',
  V_ALL_REQUIRED_PRESENT: 'Required information check', V_PLATE_CROSS_MATCH: 'Plate match check',
  V_TYPE_MATCH: 'Document type check', V_PAGE_COMPLETE: 'Page completeness check',
  V_NAME_CONSISTENCY: 'Name consistency check', V_DATE_ORDER: 'Date order check',
  V_DOB_ADULT: 'Age check', V_TIN_FORMAT: 'TIN format check',
  V_FIELD_CONFIDENCE: 'Legibility check', V_TAMPER_HEURISTIC: 'Alteration check',
  V_SELF_REPORTED_MATCH: 'Account details check', V_REQUIREMENT_COMPLETE: 'Requirements check',
  V_SHA_COLLISION: 'Duplicate file check', V_NUMBER_COLLISION: 'Duplicate number check',
  V_PHASH_NEAR: 'Similar document check', V_VELOCITY: 'Submission frequency check',
  V_MRZ_CHECKSUM: 'Machine-readable information check', V_VEHICLE_COLOUR: 'Vehicle colour check',
};
export const docLabel = (type: string) => LABELS[type] ?? 'Document';
/**
 * [Owner rulings 11 Oct 2026 — HIRE LICENCE and H-PLATE] What the reviewer checks on a taxi's papers,
 * in plain words beside the document. The ordinary licence is NOT judged for an "H" or hire class any
 * more: the right to drive a hire car is the separate Hire Car Driver's Licence (its own document).
 * Supersedes the 8 Oct "licence must include the hire-car class" wording.
 */
const REVIEWER_HINTS: Record<string, string> = {
  drivers_licence: "Ordinary driver's licence: check the name, photo and expiry. Do not look for an H or hire class — the right to drive a taxi is the separate Hire Car Driver's Licence.",
  hire_car_driver_licence: "Hire Car Driver's Licence (GRA, its own document): same name as the driver's licence, and a current date (usually 3 years).",
  hire_car_vehicle_licence: "The car's yearly hire licence: the plate matches the registration, and the date is current.",
  vehicle_registration: 'For a taxi (car or wagon car) the plate must be H-series (e.g. HC 1234) and match the plate the driver gave.',
};
export const reviewerHint = (type: string): string | undefined => REVIEWER_HINTS[type];

/**
 * [TRADES · 13 Oct 2026] What the reviewer checks on a service-trade document, in plain words.
 * A person decides every one of these; nothing here approves anything. `role` is the document's
 * filing role: a service provider's documents are filed under CUSTOMER (their super-app account).
 */
const REVIEW_NOTES: Record<string, string> = {
  pest_control_operator_licence: 'Pesticides and Toxic Chemicals Control Board licence to run a pest-control business, in this person’s name. Key the printed expiry.',
  pesticide_applicator_certificate: 'PTCCB commercial applicator certificate (urban/domestic) for this person. Valid two years from issue.',
  chartered_accountant_practising_certificate: 'ICAG practising certificate, not only membership. ICAG lists practising accountants in the Gazette each January.',
  gra_practice_certificate: 'GRA practice certificate for the current calendar year; it expires on 31 December.',
  eating_house_registration: 'Georgetown: the Town Clerk’s eating-house registration (renewed each 1 January). Outside Georgetown: the local council’s sanitary certificate for the premises.',
  town_clerk_registration: 'Town Clerk registration of this person as a barber (the by-laws cover hair, nails, face massage and similar work). Never accept a medical certificate instead.',
  town_clerk_shop_certificate: 'Town Clerk certificate of registration of the shop, for the current calendar year; it expires on 31 December.',
  drone_authorisation: 'Written authorisation from the Guyana Civil Aviation Authority to fly a camera drone, in this person’s name.',
  food_handler_cert: 'Food handler’s certificate with the issuing office and a valid-until date. Never a medical certificate; record only the date.',
};
export function reviewNote(docType: string, role: string): string | null {
  if (docType === 'drivers_licence' && role === 'CUSTOMER') {
    return 'Heavy-equipment operator: check the licence class covers the machine they drive on a road (for example a tractor).';
  }
  return REVIEW_NOTES[docType] ?? null;
}
export const roleLabel = (role: string) => LABELS[role] ?? 'Applicant';
export const vehicleLabel = (type: string) => LABELS[type] ?? 'Vehicle';
const OUTCOMES: Record<string, string> = { APPROVED: 'Approved', REJECTED: 'Rejected', PENDING: 'Awaiting review', EXPIRED: 'Expired', APPROVE: 'Approved', REJECT: 'Rejected', REQUEST_INFO: 'More information requested', ESCALATE: 'Sent for another review', SECOND_REVIEW: 'Awaiting a second reviewer', ACTIVE: 'Active', REVOKED: 'Revoked' };
/** The custody API has a legacy textual event contract. Never expose its raw fallback. */
export function timelineLabel(what: string): string {
  const submitted = /^SUBMITTED (\S+) as (\S+)$/.exec(what);
  if (submitted) return `Submitted ${docLabel(submitted[1]!)} as ${roleLabel(submitted[2]!)}`;
  const check = /^(V_\w+) (PASS|FAIL|WARN|SKIP|ERROR)(?: (\w+))?(?: \[blocking\])?$/.exec(what);
  if (check) {
    const verdict = check[3] === 'UNDETERMINABLE' ? 'could not determine' : ({ PASS: 'passed', FAIL: 'failed', WARN: 'needs attention', SKIP: 'not completed', ERROR: 'could not complete' } as Record<string, string>)[check[2]!];
    return `${LABELS[check[1]!] ?? 'Document check'}: ${verdict}${what.endsWith('[blocking]') ? ' — blocking' : ''}`;
  }
  const decision = /^(DECIDED|STATUS|RECORD) (\w+)(?: under (\w+))?$/.exec(what);
  if (decision) return `${OUTCOMES[decision[2]!] ?? 'Decision recorded'}${decision[3] && isRejectionReasonCode(decision[3]) ? `: ${rejectionLabel(decision[3])}` : ''}`;
  if (what.startsWith('CASE OPENED')) return 'Review case opened';
  if (what.startsWith('EXTRACTED FAILED')) return 'Document reading failed';
  if (what.startsWith('EXTRACTED PARTIAL')) return 'Document reading partially completed';
  if (what === 'EXTRACTED OK') return 'Document reading completed';
  if (what.startsWith('LEGAL HOLD')) return 'Document retained for legal review';
  if (what.startsWith('DESTROYED') || what.startsWith('IMAGE PURGED')) return 'Document file removed; record retained';
  if (what === 'SUBMISSION PURGED') return 'Submission removed under the retention policy';
  if (what.startsWith('AUDIT ')) {
    const decisionAudit: Record<string, string> = {
      'AUDIT APPROVE_VERIFICATION_DOC': 'Approval recorded',
      'AUDIT REJECT_VERIFICATION_DOC': 'Rejection recorded',
      'AUDIT ESCALATE_VERIFICATION_DOC': 'Sent for another review',
      'AUDIT REVOKE_VERIFICATION_DOC': 'Approval revoked',
      'AUDIT DSAR_RECTIFICATION_REQUESTED': 'Correction requested by the applicant',
      'AUDIT KYC_AUTO_APPROVE': 'Automatically approved',
      'AUDIT KYC_AUTO_REJECT': 'Automatically rejected',
      // [Owner ruling 8 Oct 2026 — CUSTOMER ID] the intake's two outcomes, in words that claim no review.
      'AUDIT CUSTOMER_ID_ON_FILE': 'ID on file — the automatic checks found nothing to hold (no person reviewed it)',
      'AUDIT CUSTOMER_ID_HELD': 'Held for a person by the automatic checks',
      'AUDIT VERIFICATION_SUBMIT': 'Document submitted',
    };
    if (decisionAudit[what]) return decisionAudit[what];
    if (what === 'AUDIT VIEW_VERIFICATION_DOC') return 'Document opened for review';
    if (/\/reject$/.test(what)) return 'Rejection request recorded';
    if (/\/approve$/.test(what)) return 'Approval request recorded';
    return 'Other activity'; // Retain the actor and time without exposing internal action strings.
  }
  return 'Document activity recorded';
}
/** Who in the custody timeline is not a person: no actor, the validator, an engine, or the server's
 *  automatic markers (an ID on file, a processor's own verdict) — never looked up as a reviewer. */
export function isSystemActor(actor: string | null): boolean {
  return !actor || actor === 'validator' || actor.startsWith('engine:') || actor.startsWith('auto:') || actor.startsWith('kyc:');
}
export interface ReviewTimelineEvent { at: string; actor: string | null; what: string; detail?: { reasonCode?: unknown; reason?: unknown } }
/** [Owner ruling 8 Oct 2026 — CUSTOMER ID] Why the automatic checks held a customer ID (server customer-id.ts codes). */
export const CUSTOMER_ID_HOLD_WORDS: Record<string, string> = {
  DUPLICATE_IMAGE: 'the same picture is on another account',
  LINKED_ACCOUNT: 'a linked account already sent an ID',
  OPEN_SUBMISSION: 'an earlier ID is still waiting',
  PRIOR_HOLD: 'an earlier ID was held and never approved',
  EARLIER_DECISION: 'an earlier ID was rejected or withdrawn',
  VELOCITY: 'too many uploads in a day',
  TOO_SMALL: 'the picture is too small to read',
  NOT_MEASURABLE: 'the file could not be measured (for example a PDF)',
  ACCOUNT_HOLD: 'the account is under an integrity hold',
  IDENTITY_REVIEW: 'the identity graph needs a person',
  STRIKES: 'the account is restricted after failed cash payments',
  PROCESSOR_REFERRED: 'the document processor referred it',
  CHECKS_UNAVAILABLE: 'the checks could not run',
};
function heldBecause(detail: ReviewTimelineEvent['detail']): string {
  const reason = typeof detail?.reason === 'string' ? detail.reason : '';
  const words = (reason.match(/[A-Z][A-Z_]{3,}/g) ?? []).map((code) => CUSTOMER_ID_HOLD_WORDS[code]).filter(Boolean);
  return words.length ? `: ${words.join('; ')}` : '';
}
function sameEscalationTime(event: ReviewTimelineEvent, other: ReviewTimelineEvent): boolean {
  const audit = event.what === 'AUDIT ESCALATE_VERIFICATION_DOC' ? event : other;
  const decision = audit === event ? other : event;
  const reason = /^DECIDED ESCALATE under (\w+)$/.exec(decision.what)?.[1];
  if (audit.detail?.reasonCode !== undefined && audit.detail.reasonCode !== reason) return false;
  // The route writes the audit after the decision transaction. For subsecond
  // differences, require its matching reason as well as the same displayed second.
  return event.at === other.at || (audit.detail?.reasonCode === reason &&
    Math.floor(Date.parse(event.at) / 1000) === Math.floor(Date.parse(other.at) / 1000));
}
/** Combine equivalent checks and matching decision/audit companions; keep distinct facts. */
export function reviewTimeline(events: ReviewTimelineEvent[]): Array<ReviewTimelineEvent & { label: string }> {
  const consumed = new Set<number>();
  return events.flatMap((event, index) => {
    if (consumed.has(index)) return [];
    let label = timelineLabel(event.what);
    if (event.what === 'AUDIT CUSTOMER_ID_HELD') label += heldBecause(event.detail);
    // A decision and its audit row may describe the same escalation. Pair once,
    // only for the same reviewer and recorded second, retaining the reason.
    const escalation = (what: string) => {
      const match = /^DECIDED ESCALATE under (\w+)$/.exec(what);
      return !!match && isRejectionReasonCode(match[1]!);
    };
    const audit = 'AUDIT ESCALATE_VERIFICATION_DOC';
    if (event.what === audit || escalation(event.what)) {
      const pair = events.findIndex((other, j) => j > index && !consumed.has(j) &&
        sameEscalationTime(event, other) && other.actor === event.actor &&
        (event.what === audit ? escalation(other.what) : other.what === audit));
      if (pair >= 0) {
        consumed.add(pair);
        const decision = event.what === audit ? events[pair]! : event;
        return [{ ...decision, label: timelineLabel(decision.what) }];
      }
    }
    const expiry = /^(V_EXPIRY_PLAUSIBLE|V_NOT_EXPIRED)( .+)$/.exec(event.what);
    if (expiry) {
      const counterpart = expiry[1] === 'V_EXPIRY_PLAUSIBLE' ? 'V_NOT_EXPIRED' : 'V_EXPIRY_PLAUSIBLE';
      const pair = events.findIndex((other, j) => j > index && !consumed.has(j) &&
        other.at === event.at && other.actor === event.actor && other.what === counterpart + expiry[2]);
      if (pair >= 0) consumed.add(pair);
      else label = label.replace('Expiry check: ', `Expiry check: ${expiry[1] === 'V_EXPIRY_PLAUSIBLE' ? 'date plausibility' : 'not expired'} — `);
    }
    return [{ ...event, label }];
  });
}
/** [MC-AD1] The marker for a re-submission, in words; null for a first upload. */
export function resubmissionLabel(doc: Pick<ReviewDocument, 'previousDecision'>): string | null {
  const prev = doc.previousDecision;
  if (!prev) return null;
  return prev.kind === 'RESUBMITTED_AFTER_REJECTION' ? 'Re-submitted after rejection' : 'Renewal';
}
const shortDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric' }) : null);
/** [MC-AD1] What the earlier decision was, in one sentence (the reviewer's note is quoted separately). */
export function previousDecisionLine(prev: PreviousDecision): string {
  const when = shortDay(prev.decidedAt);
  if (prev.kind === 'RESUBMITTED_AFTER_REJECTION') return `Rejected ${when ?? 'earlier'}. This upload answers that rejection.`;
  if (prev.status === 'EXPIRED') return `This upload replaces a document that expired${when ? ` (decided ${when})` : ''}.`;
  return `This upload renews a document approved ${when ?? 'earlier'}.`;
}
export const applicantId = (doc: ReviewDocument) => doc.userId || doc.user?.id || doc.id;
export const maskedPhone = (phone?: string) => phone ? `••• ••• ${phone.slice(-4)}` : 'No phone on file';

/** Follow the server's page metadata. No partial success if a later page fails. */
/**
 * [Owner report 8 Oct 2026] New uploads did not appear in an open Review Center until a reload. The counts are
 * polled lightly; when the server holds more documents in this lane than the page loaded, the page says how many
 * are new and offers a refresh — the list a reviewer is working through never shifts under them.
 */
export function newSinceLoaded(
  counts: { byStatus?: Record<string, number>; byLane?: Record<string, { customer: number; operator: number }> } | undefined,
  status: ReviewStatus, lane: ReviewLane, loaded: number,
): number {
  if (!counts) return 0;
  const onServer = lane === 'customer' ? counts.byLane?.[status]?.customer
    : lane === 'operator' ? counts.byLane?.[status]?.operator
      : counts.byStatus?.[status];
  return typeof onServer === 'number' && onServer > loaded ? onServer - loaded : 0;
}
/** How often the lane counts are re-read while the Review Center is open (cheap: one grouped count). */
export const REVIEW_COUNTS_POLL_MS = 30_000;
export async function loadReviewQueue(status: ReviewStatus, lane: ReviewLane): Promise<ReviewDocument[]> {
  const docs = new Map<string, ReviewDocument>();
  for (let page = 1; ; page++) {
    const result = await fetchVerificationQueue(status, lane, page);
    if (!Array.isArray(result.data)) throw new Error('The queue returned no document list.');
    for (const doc of result.data as ReviewDocument[]) docs.set(doc.id, doc);
    if (!result.meta?.hasNext) break;
    // Fail closed on malformed/non-progressing pagination rather than looping forever.
    if (!result.data.length || page >= 1000) throw new Error('The queue could not be loaded completely. Narrow the lane and retry.');
  }
  return [...docs.values()];
}
export function groupApplicants(docs: ReviewDocument[]): Applicant[] {
  const groups = new Map<string, Applicant>();
  for (const doc of docs) {
    const id = applicantId(doc);
    const created = Date.parse(doc.createdAt ?? '') || 0;
    const group = groups.get(id) ?? {
      id, name: [doc.user?.firstName, doc.user?.lastName].filter(Boolean).join(' ') || 'Unnamed applicant',
      phone: doc.user?.phone ?? '', documents: [], oldest: created,
    };
    group.documents.push(doc);
    group.oldest = Math.min(group.oldest, created);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.oldest - b.oldest || a.id.localeCompare(b.id));
}
export function waitingSince(timestamp: number, now: number): string {
  if (!timestamp) return 'Submission time unavailable';
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `Waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Waiting ${hours}h` : `Waiting ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
