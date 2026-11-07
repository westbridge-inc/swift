import type { Prisma, PrismaClient } from '@prisma/client';
import {
  INVESTIGATION_HOLD_PLACER, INVESTIGATION_HOLD_REASON, investigationOpen, liveChainMembers, openIdentityReviewGroups, openInvestigationSuccessor, reasonOf,
  releasedByPerson, type InvestigationKey,
} from './investigation-hold-core';

// ---------------------------------------------------------------------------
// [SEC-PII · money/trust scan 28 Oct 2026 · COORD rulings] AN OPEN INVESTIGATION PLACES A REAL SAFETY HOLD.
//
// A person's own erasure, the retention reaper and the abandoned-application sweep already keep a document under
// a legal or safety hold. What had no hold was the time BEFORE a decision: a document whose fraud suspicion waits
// on a second reviewer, or an identity group under review. Those documents could be erased before anyone decided.
//
// So the system places a hold, in the existing legal-hold table, on THAT person's documents when an investigation
// opens, ONE system hold per investigation (its key is in the reason):
//   - INVESTIGATION_OPEN second-review:<document id>  (escalateToSecondReview): the suspected document itself;
//   - INVESTIGATION_OPEN identity-review:<group id>   (staging an identity review: every document of each member,
//     holdIdentityReviewMembers).
// (A confirmed fraud case places a person's hold on its subject: placeDocLegalHoldIn. Linked accounts are never held.)
//
// Precedence (each document carries ONE legalHoldId):
//   - a person's hold always wins: the system never stamps a document a person's hold keeps, and a person's hold takes
//     over documents a system hold keeps (a person may also release a system hold: the system never places that
//     investigation's hold for that person again);
//   - the system releases ONLY its own holds (placedBy = INVESTIGATION_HOLD_PLACER, reason INVESTIGATION_OPEN), only
//     when that hold's own investigation has closed, without the human release check (recusal / identity review): a
//     pending identity review never keeps a document past the investigation that held it. Every other release keeps
//     the strict human check. [COORD renewal ruling] At its review date (INVESTIGATION_HOLD_DAYS) a hold whose
//     investigation is genuinely still open is RENEWED (same hold, +90 days, audited 'investigation still open,
//     renewed by system', the person told the new date); past INVESTIGATION_HOLD_ESCALATE_DAYS in all it becomes an
//     admin task for a person to decide, and the system keeps renewing until one does;
//   - on release, only documents still stamped with THAT hold move: to another open system hold of the same person
//     if there is one (its investigation still needs them), otherwise they are unstamped and the existing retry
//     erasure (the reaper on a deferred clock, the person's request) takes them as before.
// Every placement and release is audited. Erasure answers a held document with the existing legal-hold refusal,
// and a request this delays is told why (generically) and when, in writing (erasureDelayedWords).
// ---------------------------------------------------------------------------

export { INVESTIGATION_HOLD_PLACER, INVESTIGATION_HOLD_REASON, type InvestigationKey };
export const INVESTIGATION_HOLD_DAYS = 90;
/** [COORD renewal ruling] After this long in all, a hold the system keeps renewing goes to a person to decide. */
export const INVESTIGATION_HOLD_ESCALATE_DAYS = 180;
export const RENEWED_BY_SYSTEM = 'investigation still open, renewed by system';
const PAGE = 200;

/** What the sweep needs from outside: telling the person, telling the admins, and finishing a delayed erasure. */
export interface InvestigationHoldDeps {
  /** A person whose erasure this hold delays is told the new date (inbox). Never a person who asked for nothing. */
  notifyPerson?: (userId: string, revisitBy: Date, holdId: string) => Promise<void>;
  /** A hold renewed past INVESTIGATION_HOLD_ESCALATE_DAYS: an admin task, for a person to decide. */
  escalate?: (hold: { id: string; subjectUserId: string; reason: string; placedAt: Date }) => Promise<void>;
  /** Documents a release freed (no other open investigation needs them): finish any erasure their person asked for. */
  onFreed?: (userId: string, documentIds: string[]) => Promise<void>;
  /** [REVIEW-G S3-3] The catch-all: every delayed request whose documents are now unheld (a person's release, a failed
   *  completion) is finished. Returns how many requests it ran. */
  retryDelayedErasures?: () => Promise<number>;
}
const DAY_MS = 86_400_000;

type Db = PrismaClient | Prisma.TransactionClient;

const lockPerson = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE /* verification-document-purge-authority */`;

/** [Privacy §6] "If we cannot act on a deletion request straight away, we tell you why and when, in writing."
 *  The reason is generic (a review), never the review's kind or any fraud detail; the date is the hold's review date. */
export const guyanaDay = (at: Date) => at.toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'long', year: 'numeric' });

export function erasureDelayedWords(revisitBy: Date, othersDone = false, documents = 2): { title: string; body: string } {
  const day = guyanaDay(revisitBy);
  // [REVIEW-G S3-4] "Everything else ... has been deleted" only when it is true. [REVIEW-F S4-3] One document: singular.
  const what = documents === 1
    ? 'One of your documents is part of a review that is still open, so we cannot delete it yet.'
    : 'Some of your documents are part of a review that is still open, so we cannot delete them yet.';
  return {
    title: 'Your deletion request is delayed',
    body: `${what} We will look at your request again by ${day}.${othersDone ? ' Everything else you asked us to delete has been deleted.' : ''}`,
  };
}

/** [REVIEW-F S4-4 · COORD] The close of a delayed request: told once its documents are deleted. */
export function erasureCompletedWords(documents: number): { title: string; body: string } {
  return documents === 1
    ? { title: 'Your document has been deleted', body: 'We have now deleted the document you asked us to delete.' }
    : { title: 'Your documents have been deleted', body: 'We have now deleted the documents you asked us to delete.' };
}

/** [REVIEW-F S3-2 · COORD 10:44Z] The account-deletion answer is a two-line toast (90 characters at most, the date
 *  inside it). 'At least': a renewal can move the date, so it is never promised as firm. Counts every kept document. */
export function accountClosedKeptWords(revisitBy: Date, documents: number): string {
  // [REVIEW-F #2190 S3-1] At 1.3x text two toast lines hold about 60-68 characters: the date comes FIRST.
  return `Account closed. Until at least ${guyanaShortDay(revisitBy)}, ${documents === 1 ? '1 document is' : `${documents} documents are`} kept for a check, then deleted.`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** [REVIEW-F · COORD 16:02Z] "30 Sep 2027": the Guyana day with a fixed three-letter month (never the locale's 'Sept'),
 *  so the toast fits at large font sizes. */
export function guyanaShortDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(at);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return `${pick('day')} ${SHORT_MONTHS[pick('month') - 1]} ${pick('year')}`;
}

/** How many of the person's documents the system's investigation holds keep, and the latest of their review dates. */
export async function investigationHoldSummary(db: Db, userId: string): Promise<{ revisitBy: Date | null; documents: number }> {
  const held = await db.verificationDocument.findMany({
    where: { userId, purgedAt: null, legalHold: { placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null } },
    select: { legalHold: { select: { reviewBy: true } } },
  });
  const dates = held.map((d) => d.legalHold?.reviewBy.getTime() ?? 0).filter((t) => t > 0);
  return { revisitBy: dates.length > 0 ? new Date(Math.max(...dates)) : null, documents: held.length };
}

/** The latest review date among the person's documents a system investigation hold keeps, or null. */
export async function investigationHoldRevisitBy(db: Db, userId: string): Promise<Date | null> {
  const held = await db.verificationDocument.findMany({
    where: { userId, purgedAt: null, legalHold: { placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null } },
    select: { legalHold: { select: { reviewBy: true } } },
  });
  const dates = held.map((d) => d.legalHold?.reviewBy.getTime() ?? 0).filter((t) => t > 0);
  return dates.length > 0 ? new Date(Math.max(...dates)) : null;
}

/** An investigation of this person opened: its own system hold, stamping only documents no hold keeps. Idempotent
 *  per investigation. Inside the caller's transaction, under the person's row lock (the purge's lock). */
export async function placeInvestigationHold(tx: Prisma.TransactionClient, subjectUserId: string, key: InvestigationKey, now = new Date()): Promise<string | null> {
  await lockPerson(tx, subjectUserId);
  const reason = reasonOf(key);
  const existing = await tx.docLegalHold.findFirst({ where: { subjectUserId, placedBy: INVESTIGATION_HOLD_PLACER, reason, releasedAt: null }, select: { id: true, reviewBy: true } });
  // [REVIEW-M S3-1 · COORD] An existing hold still takes the person's documents that arrived since (audited refresh).
  if (existing) {
    const refreshed = await stampUnheld(tx, subjectUserId, key, existing.id);
    if (refreshed > 0) {
      await tx.auditLog.create({ data: { userId: null, action: 'REFRESH_INVESTIGATION_HOLD', entity: 'DocLegalHold', entityId: existing.id, changes: { subjectUserId, investigation: key.kind, documents: refreshed } } });
    }
    return existing.id;
  }
  // [REVIEW-G S3-2] A person released this investigation's hold for this subject: a human decided; never placed again.
  if (await releasedByPerson(tx, subjectUserId, key)) return null;
  const hold = await tx.docLegalHold.create({ data: {
    subjectUserId, reason, ownerId: INVESTIGATION_HOLD_PLACER, placedBy: INVESTIGATION_HOLD_PLACER, placedAt: now,
    reviewBy: new Date(now.getTime() + INVESTIGATION_HOLD_DAYS * DAY_MS),
  } });
  const stamped = await stampUnheld(tx, subjectUserId, key, hold.id);
  await tx.auditLog.create({ data: {
    userId: null, action: 'PLACE_INVESTIGATION_HOLD', entity: 'DocLegalHold', entityId: hold.id,
    changes: { subjectUserId, investigation: key.kind, documents: stamped, reviewBy: hold.reviewBy.toISOString() },
  } });
  return hold.id;
}

/** Stamp the person's documents no hold keeps onto this investigation's hold. A second review holds the suspected
 *  document (the evidence); an identity review, every document of the member. [Row 243] Bytes a purge already
 *  shredded are never claimed (the same rule as placeDocLegalHoldIn). The caller holds the person's lock. */
async function stampUnheld(tx: Prisma.TransactionClient, subjectUserId: string, key: InvestigationKey, holdId: string): Promise<number> {
  const only = key.kind === 'second-review' ? { id: key.documentId } : {};
  const candidates = await tx.verificationDocument.findMany({ where: { userId: subjectUserId, purgedAt: null, legalHoldId: null, ...only }, select: { id: true, fileUrl: true } });
  if (candidates.length === 0) return 0;
  const keys = candidates.map((d) => d.fileUrl).filter((k) => k !== '');
  const shredded = new Set(keys.length === 0 ? [] : (await tx.encryptedObject.findMany({ where: { fileKey: { in: keys }, shreddedAt: { not: null } }, select: { fileKey: true } })).map((o) => o.fileKey));
  const stamped = await tx.verificationDocument.updateMany({
    where: { id: { in: candidates.filter((d) => !shredded.has(d.fileUrl)).map((d) => d.id) }, purgedAt: null, legalHoldId: null },
    data: { legalHoldId: holdId },
  });
  return stamped.count;
}

/** [REVIEW-G S3-3] Where the backstop would keep a person's documents with no hold (an open identity review the
 *  sweep has not reached them for yet), place that review's hold now, so the person gets a real hold, its date and
 *  the written why/when. Called before an erasure. */
export async function holdForOpenIdentityReviews(prisma: PrismaClient, userId: string, now = new Date()): Promise<number> {
  const groups = await openIdentityReviewGroups(prisma, userId);
  for (const clusterId of groups) await prisma.$transaction((tx) => placeInvestigationHold(tx, userId, { kind: 'identity-review', clusterId }, now));
  return groups.length;
}

/** The system releases ONE of its own holds (never a person's), audited; its documents move to another open system
 *  hold of the person, or are unstamped. No human release check: this path is the system's alone. */
async function releaseSystemHold(tx: Prisma.TransactionClient, hold: { id: string; subjectUserId: string }, why: string, now: Date): Promise<string[]> {
  await lockPerson(tx, hold.subjectUserId);
  const won = await tx.docLegalHold.updateMany({
    where: { id: hold.id, placedBy: INVESTIGATION_HOLD_PLACER, reason: { startsWith: `${INVESTIGATION_HOLD_REASON} ` }, releasedAt: null },
    data: { releasedAt: now, releasedBy: INVESTIGATION_HOLD_PLACER, releaseReason: why },
  });
  if (won.count !== 1) return [];
  const successor = await openInvestigationSuccessor(tx, hold.subjectUserId, now, hold.id);
  const kept = await tx.verificationDocument.findMany({ where: { legalHoldId: hold.id }, select: { id: true } });
  const moved = await tx.verificationDocument.updateMany({ where: { legalHoldId: hold.id }, data: { legalHoldId: successor } });
  await tx.auditLog.create({ data: {
    userId: null, action: 'RELEASE_INVESTIGATION_HOLD', entity: 'DocLegalHold', entityId: hold.id,
    changes: { subjectUserId: hold.subjectUserId, reason: why, documents: moved.count, ...(successor ? { keptBy: successor } : {}) },
  } });
  return successor ? [] : kept.map((d) => d.id);
}

/** A decision that may have closed an investigation of this person: release each of their system holds whose own
 *  investigation is closed. Inside the decision's transaction. */
export async function releaseClosedInvestigationHolds(tx: Prisma.TransactionClient, subjectUserId: string, now = new Date()): Promise<string[]> {
  const holds = await tx.docLegalHold.findMany({ where: { subjectUserId, placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null }, orderBy: { placedAt: 'asc' }, select: { id: true, subjectUserId: true, reason: true } });
  const freed: string[] = [];
  for (const hold of holds) {
    if (await investigationOpen(tx, hold.reason)) continue;
    freed.push(...await releaseSystemHold(tx, hold, 'investigation closed', now));
  }
  return freed;
}

/** Daily: every active system hold is examined (paged by id, never only the oldest few): it ends when its own
 *  investigation has closed; at its review date with the investigation still open it is renewed (see the header). Then every open identity review holds every member of its LIVE chain (the backfill for
 *  reviews opened before this rule, and the refresh for members who joined or groups merged in since). */
export async function sweepInvestigationHolds(prisma: PrismaClient, now = new Date(), page = PAGE, deps: InvestigationHoldDeps = {}): Promise<{ closed: number; renewed: number; escalated: number; examined: number; held: number }> {
  const out = { closed: 0, renewed: 0, escalated: 0, examined: 0, held: 0 };
  let cursor: string | undefined;
  for (;;) {
    const holds = await prisma.docLegalHold.findMany({
      where: { placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' }, take: page, select: { id: true, subjectUserId: true, reason: true, reviewBy: true, placedAt: true },
    });
    if (holds.length === 0) break;
    cursor = holds[holds.length - 1]!.id;
    for (const hold of holds) {
      out.examined += 1;
      let freed: string[] = [];
      let renewedTo: Date | null = null;
      let escalate = false;
      await prisma.$transaction(async (tx) => {
        if (!(await investigationOpen(tx, hold.reason))) {
          freed = await releaseSystemHold(tx, hold, 'investigation closed', now);
          out.closed += 1;
        } else if (hold.reviewBy.getTime() <= now.getTime()) {
          // [COORD renewal ruling] Still open at its date: an explicit RENEW of the same hold (never release-then-replace).
          renewedTo = new Date(now.getTime() + INVESTIGATION_HOLD_DAYS * DAY_MS);
          const won = await tx.docLegalHold.updateMany({ where: { id: hold.id, releasedAt: null, reviewBy: hold.reviewBy }, data: { reviewBy: renewedTo } });
          if (won.count !== 1) { renewedTo = null; return; }
          await tx.auditLog.create({ data: { userId: null, action: 'RENEW_INVESTIGATION_HOLD', entity: 'DocLegalHold', entityId: hold.id,
            changes: { subjectUserId: hold.subjectUserId, reason: RENEWED_BY_SYSTEM, from: hold.reviewBy.toISOString(), to: renewedTo.toISOString() } } });
          out.renewed += 1;
          // At 180 days in all, a person decides (once): an admin task; the system keeps renewing until then.
          if (now.getTime() - hold.placedAt.getTime() >= INVESTIGATION_HOLD_ESCALATE_DAYS * DAY_MS
              && await tx.auditLog.count({ where: { action: 'ESCALATE_INVESTIGATION_HOLD', entityId: hold.id } }) === 0) {
            await tx.auditLog.create({ data: { userId: null, action: 'ESCALATE_INVESTIGATION_HOLD', entity: 'DocLegalHold', entityId: hold.id,
              changes: { subjectUserId: hold.subjectUserId, heldSince: hold.placedAt.toISOString(), reason: 'renewed past 180 days: a person decides' } } });
            escalate = true;
            out.escalated += 1;
          }
        }
      });
      const to = renewedTo as Date | null;
      if (to && deps.notifyPerson) await deps.notifyPerson(hold.subjectUserId, to, hold.id).catch(() => undefined);
      if (escalate && deps.escalate) await deps.escalate(hold).catch(() => undefined);
      if (freed.length > 0 && deps.onFreed) await deps.onFreed(hold.subjectUserId, freed).catch(() => undefined);
    }
    if (holds.length < page) break;
  }
  let reviewCursor: string | undefined;
  for (;;) {
    const reviews = await prisma.identityReviewCase.findMany({
      where: { status: 'OPEN', ...(reviewCursor ? { id: { gt: reviewCursor } } : {}) }, orderBy: { id: 'asc' }, take: page, select: { id: true, clusterId: true },
    });
    if (reviews.length === 0) break;
    reviewCursor = reviews[reviews.length - 1]!.id;
    out.held += await holdIdentityReviewMembers(prisma, reviews.map((r) => ({ clusterId: r.clusterId, status: 'OPEN' })), now);
    if (reviews.length < page) break;
  }
  if (deps.retryDelayedErasures) await deps.retryDelayedErasures().catch(() => 0);
  return out;
}

/** An identity review is open on a group: EVERY member of the group's live chain (its members and those of every
 *  group merged into it, read now, never a snapshot's possibly truncated list) is held by that review's own system
 *  hold. Idempotent: called when a review is staged and again by the daily sweep. Returns the members it looked at. */
export async function holdIdentityReviewMembers(prisma: PrismaClient, cases: ReadonlyArray<{ clusterId: string; status: string }>, now = new Date()): Promise<number> {
  let held = 0;
  for (const c of cases) {
    if (c.status !== 'OPEN') continue;
    for (const accountId of await liveChainMembers(prisma, c.clusterId)) {
      await prisma.$transaction((tx) => placeInvestigationHold(tx, accountId, { kind: 'identity-review', clusterId: c.clusterId }, now));
      held += 1;
    }
  }
  return held;
}
