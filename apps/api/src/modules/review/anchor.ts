/**
 * [STA-1 3.1 / 3.2] The review session's geographic anchor, and how the
 * fiction's geography is placed around it.
 *
 * The synthetic city is authored as OFFSETS from a fiction origin. On the
 * reviewer's first authenticated request the session binds ONE anchor and the
 * whole city translates rigidly around it — relative distances, drive times
 * and route shapes are preserved, and OSRM returns real routes wherever the
 * reviewer actually is.
 *
 * Write-once. A reviewer who opens the app in the office and again at home
 * sees the same city, not a second one. This module is the ONLY writer of
 * anchorLat / anchorLng / anchorSource / anchoredAt; a source census in
 * review-tenant-contract.test.ts holds that.
 */
import type { PrismaClient, ReviewFixture, ReviewSessionStatus } from '@prisma/client';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';

export type AnchorSource = 'DEVICE_GPS' | 'IP_GEO';
export interface Anchor { lat: number; lng: number }
export interface AnchorCandidate extends Anchor { source: AnchorSource }
export interface BoundAnchor extends Anchor { source: AnchorSource; wasAlreadyBound: boolean }

/** 3.2: an offset past this leaves "one believable city" (6–8 km across). */
export const MAX_OFFSET_DEG = 0.09;

const CLOSED: ReadonlySet<ReviewSessionStatus> = new Set<ReviewSessionStatus>(['EXPIRED', 'REVOKED']);

/** 410: the session is over. The app shows the DL-9 honest screen, never production data. */
export class ReviewSessionClosedError extends AppError {
  constructor(sessionId: string | null, status: ReviewSessionStatus) {
    super(410, 'REVIEW_SESSION_CLOSED', sessionId ? `Review session ${sessionId} is ${status}` : 'This demo session has expired');
    this.name = 'ReviewSessionClosedError';
  }
}

function assertCoordinate(c: Anchor, what: string): void {
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng) || Math.abs(c.lat) > 90 || Math.abs(c.lng) > 180) {
    throw new ValidationError(`${what} is not a coordinate`);
  }
}

/** A writer used inside or outside a transaction. */
type ReviewSessionWriter = Pick<PrismaClient, 'reviewSession'>;

/**
 * Binds the review session's geographic anchor on first authenticated request.
 * Idempotent: if already anchored, returns the existing anchor unchanged.
 * Throws if the session is EXPIRED or REVOKED, or does not exist.
 *
 * Callers prefer DEVICE_GPS when the client supplied a location and fall back
 * to IP_GEO; whichever arrives first wins, and nothing re-anchors. Two
 * concurrent first requests race on ONE compare-and-set UPDATE — the row lock
 * serialises them and the loser re-reads the winner's anchor.
 */
export async function bindReviewAnchor(
  db: ReviewSessionWriter,
  sessionId: string,
  candidate: AnchorCandidate,
): Promise<BoundAnchor> {
  assertCoordinate(candidate, 'anchor candidate');
  const took = await db.reviewSession.updateMany({
    where: { id: sessionId, anchorLat: null, status: { notIn: [...CLOSED] } },
    data: {
      anchorLat: candidate.lat,
      anchorLng: candidate.lng,
      anchorSource: candidate.source,
      anchoredAt: new Date(),
      status: 'ANCHORED',
    },
  });
  const session = await db.reviewSession.findUnique({
    where: { id: sessionId },
    select: { status: true, anchorLat: true, anchorLng: true, anchorSource: true },
  });
  if (!session) throw new NotFoundError('ReviewSession', sessionId);
  if (CLOSED.has(session.status)) throw new ReviewSessionClosedError(sessionId, session.status);
  if (session.anchorLat === null || session.anchorLng === null) {
    // Unreachable by construction: an open, unanchored session takes the
    // write above. Refuse loudly rather than hand back a half-bound anchor.
    throw new AppError(500, 'REVIEW_ANCHOR_UNBOUND', `Review session ${sessionId} is open but carries no anchor`);
  }
  return {
    lat: session.anchorLat,
    lng: session.anchorLng,
    source: (session.anchorSource as AnchorSource | null) ?? candidate.source,
    wasAlreadyBound: took.count === 0,
  };
}

/** 3.2: refuses an authored offset that would put a fixture outside the city. */
export function assertOffsetWithinCity(fixture: Pick<ReviewFixture, 'offsetLat' | 'offsetLng'>): void {
  if (!Number.isFinite(fixture.offsetLat) || !Number.isFinite(fixture.offsetLng)
    || Math.abs(fixture.offsetLat) > MAX_OFFSET_DEG || Math.abs(fixture.offsetLng) > MAX_OFFSET_DEG) {
    throw new ValidationError(`fixture offset exceeds ${MAX_OFFSET_DEG}° — author against the fiction origin (STA-1 3.2)`);
  }
}

/**
 * Converts a stored offset into an absolute coordinate for a given session.
 * The entire synthetic city translates rigidly around the anchor.
 */
export function materialise(
  fixture: Pick<ReviewFixture, 'offsetLat' | 'offsetLng'>,
  anchor: Anchor,
): Anchor {
  assertOffsetWithinCity(fixture);
  assertCoordinate(anchor, 'anchor');
  return { lat: anchor.lat + fixture.offsetLat, lng: anchor.lng + fixture.offsetLng };
}
