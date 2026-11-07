import type { Prisma, PrismaClient } from '@prisma/client';

// [SEC-PII · COORD rulings] The pieces of the investigation hold the legal-hold and purge code share (no import
// cycle: this module imports nothing of theirs). investigation-hold.ts is the rule; read its header.

/** The system's own placer for a hold an open investigation places. */
export const INVESTIGATION_HOLD_PLACER = 'system:investigation-hold';
export const INVESTIGATION_HOLD_REASON = 'INVESTIGATION_OPEN';
const CHAIN_DEPTH = 32;
const CHAIN_MEMBERS = 500;

type Db = PrismaClient | Prisma.TransactionClient;
export type InvestigationKey = { kind: 'second-review'; documentId: string } | { kind: 'identity-review'; clusterId: string };

export const reasonOf = (key: InvestigationKey) =>
  `${INVESTIGATION_HOLD_REASON} ${key.kind === 'second-review' ? `second-review:${key.documentId}` : `identity-review:${key.clusterId}`}`;

export function keyOf(reason: string): InvestigationKey | null {
  const m = /^INVESTIGATION_OPEN (second-review|identity-review):(\S+)$/.exec(reason);
  if (!m) return null;
  return m[1] === 'second-review' ? { kind: 'second-review', documentId: m[2]! } : { kind: 'identity-review', clusterId: m[2]! };
}

/** The person's identity group and every group it was merged into, up to the root (the resolver's direction). */
export async function clusterChainUp(db: Db, userId: string): Promise<string[]> {
  const member = await db.identityClusterMember.findUnique({ where: { accountId: userId }, select: { clusterId: true } });
  const chain: string[] = [];
  let next: string | null = member?.clusterId ?? null;
  while (next && !chain.includes(next) && chain.length < CHAIN_DEPTH) {
    chain.push(next);
    const cluster: { mergedIntoId: string | null } | null = await db.identityCluster.findUnique({ where: { id: next }, select: { mergedIntoId: true } });
    next = cluster?.mergedIntoId ?? null;
  }
  return chain;
}

/** Every account in a root group's LIVE chain: its own members and the members of every group merged into it. */
export async function liveChainMembers(db: Db, rootClusterId: string): Promise<string[]> {
  const clusters = new Set<string>([rootClusterId]);
  let frontier = [rootClusterId];
  for (let depth = 0; depth < CHAIN_DEPTH && frontier.length > 0 && clusters.size < CHAIN_MEMBERS; depth++) {
    const children = await db.identityCluster.findMany({ where: { mergedIntoId: { in: frontier } }, select: { id: true }, take: CHAIN_MEMBERS });
    frontier = children.map((c) => c.id).filter((id) => !clusters.has(id));
    for (const id of frontier) clusters.add(id);
  }
  const members = await db.identityClusterMember.findMany({ where: { clusterId: { in: [...clusters] } }, select: { accountId: true }, orderBy: { accountId: 'asc' }, take: CHAIN_MEMBERS * 2 });
  return members.map((m) => m.accountId);
}

/** When the CURRENT case of this investigation opened (the open second-review case on the document, or the newest
 *  open identity review of the group), or null when none is open. */
async function currentCaseOpenedAt(db: Db, key: InvestigationKey): Promise<Date | null> {
  if (key.kind === 'second-review') {
    const c = await db.reviewCase.findFirst({ where: { submissionId: key.documentId, queue: 'SECOND_REVIEW', closedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return c?.createdAt ?? null;
  }
  const r = await db.identityReviewCase.findFirst({ where: { clusterId: key.clusterId, status: 'OPEN' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return r?.createdAt ?? null;
}

/** A PERSON released this investigation's system hold for this subject DURING ITS CURRENT CASE: a human decided, so
 *  the system neither places it again nor keeps the documents by the backstop for that case. [REVIEW-G S3-1] A
 *  release made for an earlier case never disarms a later one (a NEW review places a new hold). */
export async function releasedByPerson(db: Db, subjectUserId: string, key: InvestigationKey): Promise<boolean> {
  const since = await currentCaseOpenedAt(db, key);
  if (!since) return false;
  return await db.docLegalHold.count({ where: {
    subjectUserId, placedBy: INVESTIGATION_HOLD_PLACER, reason: reasonOf(key), releasedAt: { gte: since }, NOT: { releasedBy: INVESTIGATION_HOLD_PLACER },
  } }) > 0;
}

/** The groups of this person's LIVE chain with an OPEN identity review that still keeps them (no person released it). */
export async function openIdentityReviewGroups(db: Db, userId: string): Promise<string[]> {
  const chain = await clusterChainUp(db, userId);
  if (chain.length === 0) return [];
  const open = await db.identityReviewCase.findMany({ where: { clusterId: { in: chain }, status: 'OPEN' }, select: { clusterId: true } });
  const groups: string[] = [];
  for (const clusterId of [...new Set(open.map((r) => r.clusterId))]) {
    if (!(await releasedByPerson(db, userId, { kind: 'identity-review', clusterId }))) groups.push(clusterId);
  }
  return groups;
}

/** The lock-time backstop: is an identity review open on any group of this person's LIVE chain (and not released by a person)? */
export async function identityReviewOpenFor(db: Db, userId: string): Promise<boolean> {
  return (await openIdentityReviewGroups(db, userId)).length > 0;
}

/** Is THIS investigation still open? (An unreadable key reads as closed: the hold then ends by its date at the latest.) */
export async function investigationOpen(db: Db, reason: string): Promise<boolean> {
  const key = keyOf(reason);
  if (!key) return false;
  if (key.kind === 'second-review') {
    return await db.reviewCase.count({ where: { submissionId: key.documentId, queue: 'SECOND_REVIEW', closedAt: null } }) > 0;
  }
  return await db.identityReviewCase.count({ where: { clusterId: key.clusterId, status: 'OPEN' } }) > 0;
}

/** The person's open system hold whose investigation still needs their documents (oldest first), or null. */
export async function openInvestigationSuccessor(db: Db, subjectUserId: string, now: Date, excludeHoldId?: string): Promise<string | null> {
  const holds = await db.docLegalHold.findMany({
    // [REVIEW-G S4-1] Decided on investigationOpen alone: a successor due for renewal (in this very sweep) still counts.
    where: { subjectUserId, placedBy: INVESTIGATION_HOLD_PLACER, releasedAt: null, ...(excludeHoldId ? { id: { not: excludeHoldId } } : {}) },
    orderBy: { placedAt: 'asc' }, select: { id: true, reason: true },
  });
  for (const hold of holds) if (await investigationOpen(db, hold.reason)) return hold.id;
  return null;
}
