/**
 * [DOC-1 §7 · P7-1] Validator implementations, addressed by the registry's
 * implRef. The registry (the `validator` table, seeded from doc-registry.ts)
 * says WHICH validators exist, for which type, whether they block and which
 * §8.5 reason a FAIL carries; this module says HOW the implemented ones judge.
 * A registry row whose implRef does not resolve here is a phantom, and
 * DOC-INV-2 refuses to let an ACTIVE document type depend on one.
 */
import type { ValidationStatus } from '@prisma/client';

export interface DeclaredField { fieldCode: string; isRequired: boolean; isBlindIndexed: boolean }
/** [DOC-1 §3 · P3-3] What the submitter IS, for the taxi rules: a Driver profile = taxi work (H plate); a Rider = delivery (exempt, §3.8). */
export interface ValidatorContext {
  taxi: boolean;
  /** The registration mark on the submitter's mover profile, normalised — the cross-match anchor. */
  registrationMark: string | null;
  /** The submission's document type and its bucket — the vehicle rules apply to VEHICLE documents, the licence rule to the licence. */
  docType: string | null;
  bucket: 'PERSONAL' | 'BUSINESS' | 'VEHICLE' | null;
  /** [self-test C] The longest validity this type is ever issued for (AUTO_APPROVE_EXPIRY_DAYS); null = the rule cannot judge plausibility. */
  maxValidityDays?: number | null;
}
export const NO_CONTEXT: ValidatorContext = { taxi: false, registrationMark: null, docType: null, bucket: null, maxValidityDays: null };
/** A verdict the ledger does not record: the rule has nothing to say about this document. */
export const NOT_APPLICABLE: ValidatorVerdict = { status: 'SKIP', detailCode: 'NOT_APPLICABLE' };
export interface ValidatorInput {
  declared: readonly DeclaredField[];
  /** field code → value the processor read (declared fields only) */
  present: ReadonlyMap<string, string>;
  collided: boolean;
  context?: ValidatorContext;
}
const normMark = (m: string) => m.toUpperCase().replace(/[\s-]+/g, '');
/** A FAIL carries the registry's detailCode; SKIP and WARN may say why here. */
export interface ValidatorVerdict { status: ValidationStatus; detailCode?: string | null }
export type ValidatorImpl = (input: ValidatorInput) => ValidatorVerdict;

export const VALIDATOR_IMPLEMENTATIONS: Readonly<Record<string, ValidatorImpl>> = {
  // §7.3: every is_required field has a value. Nothing declared → SKIP, not a vacuous PASS.
  'validators#V_ALL_REQUIRED_PRESENT': ({ declared, present }) => {
    if (declared.length === 0) return { status: 'SKIP', detailCode: 'NO_DECLARED_FIELDS' };
    const missing = declared.filter((f) => f.isRequired && !present.has(f.fieldCode));
    return missing.length > 0 ? { status: 'FAIL' } : { status: 'PASS' };
  },
  // §7.5: identical content already on another subject — routes to SECOND_REVIEW (held by the collision rule); recorded as a WARN.
  'validators#V_SHA_COLLISION': ({ collided }) => (collided ? { status: 'WARN', detailCode: 'CROSS_SUBJECT_SHA' } : { status: 'PASS' }),
  // [DOC-1 §3.4 · FD-DOC-6 · P2-2] covers_hire_and_reward: a private policy does not cover carriage for hire
  // or reward. Read → PASS / FAIL; not read → SKIP (undeterminable routes to a human — never a vacuous PASS).
  // [DOC-1 §3.7 · LEGAL-CONFLICT-1 · DOC-INV-44] Only the corroborated rule: a TAXI vehicle carries an H mark.
  // Every other prefix letter is a disputed fact and is never judged. Delivery movers are exempt (§3.8).
  'validators#V_PLATE_CLASS': ({ present, context }) => {
    if (!context?.taxi || context.bucket !== 'VEHICLE') return NOT_APPLICABLE;
    const mark = present.get('registration_mark');
    if (!mark) return { status: 'SKIP', detailCode: 'UNDETERMINABLE' };
    return normMark(mark).startsWith('H') ? { status: 'PASS' } : { status: 'FAIL' };
  },
  // [Owner ruling 2026-10-01] There is no colour rule: a taxi may be any colour. This overrides
  // DOC-1 §3.7 ("hire cars are Corporate Yellow"); the H plate (V_PLATE_CLASS above) stays required.
  // V_VEHICLE_COLOUR stays declared in the registry as a retired, non-blocking row with no
  // implementation, so the results it wrote before the ruling still name a known rule.
  // Never add a colour judgement back here.
  // [DOC-1 §3.7] The mark on the document must be the mark on the vehicle — any mismatch is a hard review.
  'validators#V_PLATE_CROSS_MATCH': ({ present, context }) => {
    if (context?.bucket !== 'VEHICLE') return NOT_APPLICABLE;
    const mark = present.get('registration_mark');
    if (!mark || !context?.registrationMark) return { status: 'SKIP', detailCode: 'UNDETERMINABLE' };
    return normMark(mark) === normMark(context.registrationMark) ? { status: 'PASS' } : { status: 'FAIL' };
  },
  // [VERIFY-DOCS · owner ruling 8, 6 Oct 2026] There is no "H class" rule on the ordinary driver's licence:
  // the right to drive a hire car is the person's Hire Car Driver's Licence (s.80), a separate document the
  // taxi checklist asks for. V_LICENCE_CLASS stays declared in the registry as a retired, non-blocking row
  // with no implementation, so the results it wrote before the ruling still name a known rule.
  // Never add a licence-class judgement back here.
  // §7.2 V_NOT_EXPIRED: a printed expiry in the past is a blocking FAIL (EXPIRED_DOCUMENT).
  'validators#V_NOT_EXPIRED': ({ declared, present }) => {
    if (!declared.some((f) => f.fieldCode === 'expiry_date')) return NOT_APPLICABLE; // the type declares no expiry: nothing to say
    const expiry = parseIsoDate(present.get('expiry_date'));
    if (!expiry) return { status: 'SKIP', detailCode: 'UNDETERMINABLE' };
    return expiry.getTime() < startOfToday().getTime() ? { status: 'FAIL' } : { status: 'PASS' };
  },
  // §7.2 V_EXPIRY_PLAUSIBLE [self-test C · ruling 2026-09-06]: a confident, plausible-looking, WRONG
  // expiry must not auto-commit. The printed expiry has to sit inside the type's longest validity
  // from today (or from the printed issue date when read), with a 30-day tolerance for issuing
  // offices that round. Beyond it is a blocking FAIL → a person keys the date; never a rejection.
  'validators#V_EXPIRY_PLAUSIBLE': ({ declared, present, context }) => {
    if (!declared.some((f) => f.fieldCode === 'expiry_date')) return NOT_APPLICABLE;
    const expiry = parseIsoDate(present.get('expiry_date'));
    const max = context?.maxValidityDays ?? null;
    if (!expiry || max === null) return { status: 'SKIP', detailCode: 'UNDETERMINABLE' };
    const issue = parseIsoDate(present.get('issue_date'));
    const from = issue ?? startOfToday();
    return expiry.getTime() <= plausibleExpiryCeiling(from, max).getTime() ? { status: 'PASS' } : { status: 'FAIL' };
  },
  'validators#V_INSURANCE_SCOPE': ({ present }) => {
    const raw = present.get('covers_hire_and_reward');
    if (raw === undefined) return { status: 'SKIP', detailCode: 'UNDETERMINABLE' };
    const v = raw.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'hire', 'hire_and_reward'].includes(v)) return { status: 'PASS' };
    if (['false', 'no', 'n', '0', 'private'].includes(v)) return { status: 'FAIL' };
    return { status: 'SKIP', detailCode: 'UNDETERMINABLE' };
  },
};

export function resolvesImpl(implRef: string | null | undefined): boolean {
  return typeof implRef === 'string' && Object.hasOwn(VALIDATOR_IMPLEMENTATIONS, implRef);
}

// ---------------------------------------------------------------------------
// Expiry plausibility — shared by the field validator and the manual approval path.
// ---------------------------------------------------------------------------
export const EXPIRY_TOLERANCE_DAYS = 30;
const DAY = 86_400_000;
export function startOfToday(now = new Date()): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); }
/** The latest expiry a document of this validity can honestly carry, counted from `from`. */
export function plausibleExpiryCeiling(from: Date, maxValidityDays: number): Date {
  return new Date(from.getTime() + (maxValidityDays + EXPIRY_TOLERANCE_DAYS) * DAY);
}
/** ISO date (YYYY-MM-DD or a full timestamp) → Date, else null. */
export function parseIsoDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
