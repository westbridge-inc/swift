/**
 * [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] A customer's ID goes ON FILE at once.
 *
 * Before this ruling a customer's ID (the L2 check that unlocks taxi rides and orders at or
 * above the country's ID-gate threshold) waited for a person, like a partner document. The
 * owner ruled: an uploaded customer ID unlocks L2 RIGHT AWAY, with no admin approval, unless
 * an automatic check flags it — then it is held for a person. An admin can withdraw it at any
 * time (back to L1). Partner, driver and rider documents keep their human review unchanged.
 *
 * [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE] Taxi rides and orders at or above the
 * threshold no longer need L2. The ID stays optional and is kept as before (retention-rules.ts);
 * L2 still lifts a STRIKE_RESTRICTED account and the high-value promo gate (order.service).
 *
 * Truthfulness: "on file" means a picture of an ID is stored and the automatic checks below
 * found nothing suspicious. It does NOT mean a person (or a machine) read and confirmed the
 * ID, so nothing here — or anywhere this feeds — may say "verified by Swift". Only an ID a
 * person approved (a review decision APPROVE, the DOC-1 provenance) is "checked".
 *
 * The checks are deliberately simple and each one fails safe (a doubt → a person looks):
 *  - DUPLICATE_IMAGE     the same file (byte-identical) is already on another account;
 *  - LINKED_ACCOUNT      another account linked to the same person (identity graph) already sent one;
 *  - OPEN_SUBMISSION     an earlier ID from this account is still waiting for a person;
 *  - PRIOR_HOLD          an earlier ID from this account was held and no person decided it (e.g. the
 *                        customer erased it while it waited) — a new upload cannot step around a hold;
 *  - EARLIER_DECISION    a person rejected an earlier ID from this account, or withdrew one — even if
 *                        the customer erased it since (decisions outlive the document row);
 *  - VELOCITY            too many ID uploads from this account in a day;
 *  - TOO_SMALL           the picture is too small to read;
 *  - NOT_MEASURABLE      the file cannot be measured (a PDF, a damaged image, storage unavailable);
 *  - ACCOUNT_HOLD        the account is under an integrity hold;
 *  - IDENTITY_REVIEW     the identity graph itself needs a person;
 *  - STRIKES             the account is restricted after repeated failed cash payments;
 *  - PROCESSOR_REFERRED  a document processor that reads documents sent it to a person;
 *  - CHECKS_UNAVAILABLE  the checks could not run at all, or the document processor was down.
 * An ID goes on file only when every check RAN and none flagged it.
 * What is NOT checked automatically (no tool for it today): a blurry or blank picture of normal
 * size, a near-duplicate (re-photographed) picture, and the ID NUMBER across accounts (nobody
 * reads the number at upload under the launch's human-only verification).
 */
import type { Prisma, PrismaClient, TrustLevel } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;

/** The synthetic docType of a customer's ID (verification.service IDENTITY_DOC_TYPE; kept literal to avoid an import cycle). */
const CUSTOMER_ID_DOC_TYPE = 'identity_l2';

/** reviewedBy on an ID that went on file without a person. Never a user id, so never mistaken for a reviewer. */
export const ON_FILE_REVIEWER = 'auto:id-on-file';

export const CUSTOMER_ID_HOLD_REASONS = [
  'DUPLICATE_IMAGE', 'LINKED_ACCOUNT', 'OPEN_SUBMISSION', 'PRIOR_HOLD', 'EARLIER_DECISION', 'VELOCITY',
  'TOO_SMALL', 'NOT_MEASURABLE', 'ACCOUNT_HOLD', 'IDENTITY_REVIEW', 'STRIKES',
  'PROCESSOR_REFERRED', 'CHECKS_UNAVAILABLE',
] as const;
export type CustomerIdHoldReason = (typeof CUSTOMER_ID_HOLD_REASONS)[number];

/** A phone photo or screenshot of an ID card is far larger; below this nobody can read the print. */
export const MIN_READABLE_SHORT_SIDE = 480;
export const MIN_READABLE_LONG_SIDE = 640;
/** Earlier ID uploads from one account within the window before the next one waits for a person. */
export const VELOCITY_WINDOW_HOURS = 24;
export const VELOCITY_MAX_EARLIER = 2;

export interface ImageSize { width: number; height: number }

const plausible = (width: number, height: number): ImageSize | null =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 100_000 && height < 100_000
    ? { width, height } : null;

/**
 * Pixel size from the file HEADER only — no decoder, no new dependency. JPEG (the SOFn frame
 * header), PNG (IHDR) and WebP (VP8 / VP8L / VP8X). Anything it cannot parse is null, which the
 * intake treats as NOT_MEASURABLE (held for a person) — never as readable.
 */
export function measureImage(buf: Buffer): ImageSize | null {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG' && buf.toString('ascii', 12, 16) === 'IHDR') {
      return plausible(buf.readUInt32BE(16), buf.readUInt32BE(20));
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        return plausible(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
      }
      if (chunk === 'VP8L' && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21);
        return plausible((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === 'VP8X') {
        return plausible(buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
      }
      return null;
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 3 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1]!;
        if (marker === 0xff) { i += 1; continue; } // fill byte
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // no length
        if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame header
        const length = buf.readUInt16BE(i + 2);
        if (length < 2) return null;
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
          if (i + 9 > buf.length) return null;
          return plausible(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
        }
        i += 2 + length;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Everything the intake decides on — gathered by `readCustomerIdFacts`, judged by `customerIdHoldReasons`. */
export interface CustomerIdFacts {
  duplicateImage: boolean;
  linkedAccountSubmissions: number;
  openSubmissions: number;
  /** Earlier submissions that were held for a person (a review case) and that no person approved, not counting open ones. */
  priorHolds: number;
  earlierPersonDecision: boolean;
  earlierSubmissionsInWindow: number;
  /** null when the size check applies and the file could not be measured. */
  size: ImageSize | null;
  /** false when a document processor actually read the document (its approval stands in for the size check). */
  sizeCheckApplies: boolean;
  accountHold: boolean;
  identityReview: boolean;
  strikeRestricted: boolean;
  processorReferred: boolean;
  /** The document processor did not answer (an outage or a timeout on the degradation ladder). */
  processorUnavailable: boolean;
}

/** Pure: the automatic checks that flag this upload, in a stable order. Empty → the ID goes on file now. */
export function customerIdHoldReasons(f: CustomerIdFacts): CustomerIdHoldReason[] {
  const reasons: CustomerIdHoldReason[] = [];
  if (f.processorUnavailable) reasons.push('CHECKS_UNAVAILABLE');
  if (f.processorReferred) reasons.push('PROCESSOR_REFERRED');
  if (f.duplicateImage) reasons.push('DUPLICATE_IMAGE');
  if (f.linkedAccountSubmissions > 0) reasons.push('LINKED_ACCOUNT');
  if (f.openSubmissions > 0) reasons.push('OPEN_SUBMISSION');
  if (f.priorHolds > 0) reasons.push('PRIOR_HOLD');
  if (f.earlierPersonDecision) reasons.push('EARLIER_DECISION');
  if (f.earlierSubmissionsInWindow >= VELOCITY_MAX_EARLIER) reasons.push('VELOCITY');
  if (f.sizeCheckApplies) {
    if (!f.size) reasons.push('NOT_MEASURABLE');
    else if (Math.min(f.size.width, f.size.height) < MIN_READABLE_SHORT_SIDE || Math.max(f.size.width, f.size.height) < MIN_READABLE_LONG_SIDE) reasons.push('TOO_SMALL');
  }
  if (f.accountHold) reasons.push('ACCOUNT_HOLD');
  if (f.identityReview) reasons.push('IDENTITY_REVIEW');
  if (f.strikeRestricted) reasons.push('STRIKES');
  return reasons;
}

export interface CustomerIdFactsInput {
  userId: string;
  /** The upload's metadata row (already proven to belong to this user). */
  object: { mimeType: string };
  /** The upload's bytes, decrypted — or a throw. Only called when the size check applies. */
  readPlaintext: () => Promise<Buffer>;
  duplicateImage: boolean;
  sizeCheckApplies: boolean;
  processorReferred: boolean;
  processorUnavailable: boolean;
  now?: Date;
}

/**
 * Read the facts. Each read is real; none is guessed. A read that throws makes the whole
 * intake hold for a person (`CHECKS_UNAVAILABLE` from the caller) — the checks fail closed.
 */
export async function readCustomerIdFacts(db: Db, input: CustomerIdFactsInput): Promise<CustomerIdFacts> {
  const now = input.now ?? new Date();
  const mine = await db.verificationDocument.findMany({
    where: { userId: input.userId, docType: CUSTOMER_ID_DOC_TYPE },
    select: { id: true, status: true, state: true, createdAt: true },
  });
  const isOpen = (d: (typeof mine)[number]) => d.status === 'PENDING' && d.state !== 'SUPERSEDED' && d.state !== 'PURGED';
  const openSubmissions = mine.filter(isOpen).length;
  // Every hold opened a review case; a case with no APPROVE decision means no person cleared it.
  const cases = mine.length === 0 ? [] : await db.reviewCase.findMany({
    where: { submissionId: { in: mine.map((d) => d.id) } },
    select: { submissionId: true, decisions: { select: { outcome: true } } },
  });
  // Decided = a person approved or rejected (a withdrawal records a REJECT); those are judged by
  // EARLIER_DECISION. A held submission nobody decided that is no longer open (erased while it
  // waited) is a PRIOR_HOLD.
  const decided = new Set(cases.filter((c) => c.decisions.some((x) => x.outcome === 'APPROVE' || x.outcome === 'REJECT')).map((c) => c.submissionId));
  const held = new Set(cases.map((c) => c.submissionId));
  const priorHolds = mine.filter((d) => held.has(d.id) && !decided.has(d.id) && !isOpen(d)).length;
  const windowStart = new Date(now.getTime() - VELOCITY_WINDOW_HOURS * 3_600_000);
  const earlierSubmissionsInWindow = mine.filter((d) => d.createdAt >= windowStart).length;
  const revoked = mine.some((d) => d.state === 'REVOKED');
  // A person's REJECT decision on ANY earlier customer ID — a rejection, or a withdrawal (revoke
  // records one) — whatever became of the row since: decisions survive the customer's erasure.
  const personRejected = mine.length > 0 && (await db.reviewDecision.count({
    where: { outcome: 'REJECT', case: { submissionId: { in: mine.map((d) => d.id) } } },
  })) > 0;

  const { identityAuthority } = await import('../integrity/identity-review');
  const authority = await identityAuthority(db, input.userId);
  const others = authority.memberIds.filter((id) => id !== input.userId);
  const linkedAccountSubmissions = others.length === 0 ? 0 : await db.verificationDocument.count({
    where: { userId: { in: others }, docType: CUSTOMER_ID_DOC_TYPE },
  });

  const { hasActiveHold } = await import('../integrity/enforcement');
  const accountHold = (await hasActiveHold(db as PrismaClient, input.userId)).held;
  const { orderingRestriction } = await import('../cash/cash-rules.service');
  const restriction = await orderingRestriction(db as PrismaClient, input.userId);

  let size: ImageSize | null = null;
  if (input.sizeCheckApplies && input.object.mimeType !== 'application/pdf') {
    try { size = measureImage(await input.readPlaintext()); } catch { size = null; }
  }

  return {
    duplicateImage: input.duplicateImage,
    linkedAccountSubmissions,
    openSubmissions,
    priorHolds,
    earlierPersonDecision: revoked || personRejected,
    earlierSubmissionsInWindow,
    size,
    sizeCheckApplies: input.sizeCheckApplies,
    accountHold,
    identityReview: authority.status === 'REVIEW_REQUIRED',
    strikeRestricted: restriction !== null,
    processorReferred: input.processorReferred,
    processorUnavailable: input.processorUnavailable,
  };
}

/**
 * Who stands behind an account's ID: a PERSON (an APPROVE review decision on a committed customer
 * ID), the AUTOMATIC intake (committed with no person), or NONE (no committed customer ID — e.g.
 * an account whose trust level predates this record).
 */
export async function customerIdBasis(db: Db, userId: string): Promise<'PERSON' | 'AUTOMATIC' | 'NONE'> {
  const committed = await db.verificationDocument.findMany({
    where: { userId, docType: CUSTOMER_ID_DOC_TYPE, state: 'COMMITTED' },
    select: { id: true },
  });
  if (committed.length === 0) return 'NONE';
  const person = await db.reviewDecision.count({
    where: { outcome: 'APPROVE', case: { submissionId: { in: committed.map((d) => d.id) } } },
  });
  return person > 0 ? 'PERSON' : 'AUTOMATIC';
}

/**
 * The trust level a RIDER's cash float is sized from. "Partner, driver and rider document review
 * UNCHANGED" (the same ruling): before it, a rider's float rose above L1 only through a customer ID
 * a person approved. An ID that is merely on file must not lift it, so for the float such an
 * account counts as L1. Every other account keeps its level. If the basis cannot be read, the
 * float is sized as L1 (fails closed: the cash a rider may front never rises on a doubt).
 */
export async function floatTrustLevel(db: Db, userId: string, trustLevel: TrustLevel): Promise<TrustLevel> {
  if (trustLevel === 'L1') return trustLevel;
  let basis: 'PERSON' | 'AUTOMATIC' | 'NONE';
  try { basis = await customerIdBasis(db, userId); } catch { return 'L1'; }
  return basis === 'AUTOMATIC' ? 'L1' : trustLevel;
}

/** What the customer's own apps may say about their ID — never more than is true. */
export type CustomerIdCheck = 'NONE' | 'ON_FILE' | 'CHECKED' | 'WAITING' | 'NOT_ACCEPTED';

export async function customerIdCheck(db: Db, userId: string, trustLevel: TrustLevel): Promise<CustomerIdCheck> {
  if (trustLevel !== 'L1') {
    // An account above L1 with no committed customer ID (a level that predates this record) has no
    // ID on file to speak of: say nothing rather than "on file".
    const basis = await customerIdBasis(db, userId);
    return basis === 'PERSON' ? 'CHECKED' : basis === 'AUTOMATIC' ? 'ON_FILE' : 'NONE';
  }
  const latest = await db.verificationDocument.findFirst({
    where: { userId, docType: CUSTOMER_ID_DOC_TYPE, state: { notIn: ['SUPERSEDED', 'PURGED'] } },
    orderBy: { createdAt: 'desc' },
    select: { status: true },
  });
  if (!latest) return 'NONE';
  if (latest.status === 'PENDING') return 'WAITING';
  if (latest.status === 'REJECTED') return 'NOT_ACCEPTED';
  return 'NONE';
}
