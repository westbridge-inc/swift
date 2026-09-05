/**
 * [STA-1 3.1 / DL-9] What every authenticated request from a REVIEW tenant
 * passes through, right after the tenant is entered.
 *
 * No live review session → 410 REVIEW_SESSION_CLOSED, on every request, so the
 * app shows the honest "this demo session has expired" screen and never
 * production data. A live, unanchored session binds its anchor from the
 * device's location header, else from the IP-geolocation provider — once.
 */
import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { bindReviewAnchor, ReviewSessionClosedError, type Anchor, type AnchorCandidate } from './anchor';

/** Swappable (CLAUDE.md rule 4). There is no IP-geolocation service in this
 *  stack, so the default lands the fiction in the launch city — a real place
 *  OSRM can route in — and says so in anchorSource ("IP_GEO"). */
export interface IpGeoProvider { locate(ip: string | undefined): Promise<Anchor | null> }
export const LAUNCH_CITY: Anchor = { lat: 6.8013, lng: -58.1551 }; // Georgetown
export const launchCityIpGeo: IpGeoProvider = { locate: async () => LAUNCH_CITY };

/** "lat,lng" from the device — DEVICE_GPS, preferred (3.1). */
export const LOCATION_HEADER = 'x-swift-location';
const LOCATION = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const LIVE = ['PROVISIONED', 'ANCHORED'] as const;
const LAST_SEEN_THROTTLE_MS = 60_000;

export async function candidateFrom(
  request: Pick<FastifyRequest, 'headers' | 'ip'>,
  ipGeo: IpGeoProvider,
): Promise<AnchorCandidate | null> {
  const raw = request.headers[LOCATION_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const m = header ? LOCATION.exec(header) : null;
  if (m) {
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, source: 'DEVICE_GPS' };
  }
  const located = await ipGeo.locate(request.ip);
  return located ? { ...located, source: 'IP_GEO' } : null;
}

/** Runs INSIDE the review tenant's context (after enterTenant), so the
 *  session lookup is already scoped to that tenant. */
export async function reviewGate(
  prisma: PrismaClient,
  request: Pick<FastifyRequest, 'headers' | 'ip'>,
  ipGeo: IpGeoProvider = launchCityIpGeo,
): Promise<void> {
  const now = new Date();
  const live = await prisma.reviewSession.findFirst({
    where: { status: { in: [...LIVE] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, expiresAt: true, anchoredAt: true, lastSeenAt: true },
  });
  if (!live) throw new ReviewSessionClosedError(null, 'EXPIRED');
  if (live.expiresAt <= now) {
    // Expire on read, compare-and-set: a concurrent revoke keeps REVOKED.
    await prisma.reviewSession.updateMany({ where: { id: live.id, status: { in: [...LIVE] } }, data: { status: 'EXPIRED' } });
    throw new ReviewSessionClosedError(live.id, 'EXPIRED');
  }
  if (live.anchoredAt === null) {
    const candidate = await candidateFrom(request, ipGeo);
    if (candidate) await bindReviewAnchor(prisma, live.id, candidate);
  }
  if (!live.lastSeenAt || now.getTime() - live.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await prisma.reviewSession.updateMany({ where: { id: live.id }, data: { lastSeenAt: now } });
  }
}
