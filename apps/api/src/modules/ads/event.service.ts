import { Prisma, type PrismaClient, type AdEventType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { adTokenMatchesPrincipal, userHash, verifyImpressionToken, adIdentity } from './ads-token';

// Ad event ingestion (ads-platform spec §12.2). Recorded serve grants bound
// client reports to a serving decision, principal, lifetime and event sequence.
// They do not prove a human view. Grant transitions, dedupe, frequency and
// telemetry commit together. Raw user ids never enter AdEvent.

const VIEWABLE = 'VIEWABLE_IMPRESSION';

export interface IncomingEvent {
  token: string;
  eventType: AdEventType;
  occurredAt: string; // ISO
  meta?: Record<string, unknown>;
}

export type EventVerdict = 'accepted' | 'duplicate' | 'invalid';

export interface AdEventRequestPrincipal {
  userId: string | null;
  authPresented: boolean;
  guestId?: string;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class AdEventService {
  constructor(private prisma: PrismaClient) {}

  /** Ingest a batch (≤50). Per-item verdict, in order. The principal's user
   *  id comes only from verified server auth; it is used transiently to verify
   *  token scope and derive the daily hash, never persisted in ad telemetry. */
  async ingest(events: IncomingEvent[], principal: AdEventRequestPrincipal, now = new Date()): Promise<EventVerdict[]> {
    const verdicts: EventVerdict[] = [];
    for (const ev of events) {
      verdicts.push(await this.ingestOne(ev, principal, now));
    }
    return verdicts;
  }

  private async ingestOne(ev: IncomingEvent, principal: AdEventRequestPrincipal, now: Date): Promise<EventVerdict> {
    const verdict = verifyImpressionToken(ev.token, now.getTime());
    if (!verdict.ok || verdict.payload.v !== 2 || !verdict.payload.i || !verdict.payload.t) return 'invalid';
    // A token issued to user A can never acquire user B's attribution, and a
    // guest token stays guest-only. This check precedes dedupe/frequency writes
    // so a rejected replay cannot consume the legitimate event.
    if (!adTokenMatchesPrincipal(verdict.payload, principal.userId, principal.authPresented)) return 'invalid';
    const { c: campaignId, r: creativeId, p: placementKey, s: sessionId } = verdict.payload;
    const th = tokenHash(ev.token);
    const currentUserHash = principal.userId ? userHash(principal.userId, now.toISOString().slice(0, 10)) : null;

    const occurredAt = this.safeDate(ev.occurredAt, now);

    // Campaign authority, the exact dedupe claim, frequency mutation, and the
    // bounded client report are one commit. FOR KEY SHARE makes a concurrently
    // deleted campaign wait until this event commits; an already-missing
    // campaign is invalid and can never fall through to a default tenant.
    return this.prisma.$transaction(async (tx): Promise<EventVerdict> => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${verdict.payload.t}, true)`;
      const campaigns = await tx.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
        SELECT "tenantId"
        FROM "ad_campaigns"
        WHERE "id" = ${campaignId} AND "tenantId" = ${verdict.payload.t}
        FOR KEY SHARE
      `);
      const campaign = campaigns[0];
      if (!campaign) return 'invalid';

      const grants = await tx.$queryRaw<Array<{ principalHash: string; campaignId: string; creativeId: string; placementKey: string; issuedAt: Date; expiresAt: Date; eventMask: number; kind: string; durationMs: number }>>(Prisma.sql`
        SELECT * FROM "ad_serve_grants" WHERE "id" = ${verdict.payload.i} AND "tenantId" = ${campaign.tenantId} FOR UPDATE
      `);
      const grant = grants[0];
      if (!grant || grant.expiresAt <= now || grant.expiresAt.getTime() !== verdict.payload.e
        || grant.principalHash !== adIdentity(principal.userId, principal.guestId)
        || grant.campaignId !== campaignId || grant.creativeId !== creativeId || grant.placementKey !== placementKey) return 'invalid';
      const bits: Record<AdEventType, number> = { IMPRESSION: 1, VIEWABLE_IMPRESSION: 2, CLICK: 4, VIDEO_START: 8, VIDEO_Q25: 16, VIDEO_Q50: 32, VIDEO_Q75: 64, VIDEO_COMPLETE: 128 };
      const bit = bits[ev.eventType];
      if (!bit) return 'invalid';
      if (grant.eventMask & bit) return 'duplicate';
      // Permit one minute of client clock skew, never backdating a grant into
      // unrelated historical traffic. Progress uses server elapsed time.
      if (occurredAt.getTime() < grant.issuedAt.getTime() - 60_000) return 'invalid';
      const elapsed = now.getTime() - grant.issuedAt.getTime();
      if (elapsed < 0 || (bit !== 1 && !(grant.eventMask & 1))) return 'invalid';
      if (bit === 2 && elapsed < 1000) return 'invalid';
      if (bit >= 8) {
        if (grant.kind !== 'VIDEO' || grant.durationMs <= 0) return 'invalid';
        const prior: Record<number, number> = { 16: 8, 32: 16, 64: 32, 128: 64 };
        const fraction: Record<number, number> = { 16: 0.25, 32: 0.5, 64: 0.75, 128: 0.98 };
        if (prior[bit] && !(grant.eventMask & prior[bit]!)) return 'invalid';
        if (elapsed < grant.durationMs * (fraction[bit] ?? 0)) return 'invalid';
      }

      // Only a conflict on this exact (tokenHash, eventType) claim is a
      // duplicate. A broad P2002 catch would hide unrelated data-integrity
      // faults in the frequency/event writes and permanently lose telemetry.
      const claims = await tx.$queryRaw<Array<{ tokenHash: string }>>(Prisma.sql`
        INSERT INTO "ad_event_dedupe" ("tokenHash", "eventType", "createdAt")
        VALUES (${th}, ${ev.eventType}::"AdEventType", NOW())
        ON CONFLICT ("tokenHash", "eventType") DO NOTHING
        RETURNING "tokenHash"
      `);
      if (claims.length === 0) return 'duplicate';

      // Freq counter on viewable impressions only (§12.2), keyed by
      // userHash+day. It commits iff the corresponding event commits.
      if (ev.eventType === VIEWABLE && currentUserHash) {
        const day = new Date(now.toISOString().slice(0, 10));
        await tx.adFreqCounter.upsert({
          where: { userHash_placementKey_day: { userHash: currentUserHash, placementKey, day } },
          create: { userHash: currentUserHash, placementKey, day, count: 1 },
          update: { count: { increment: 1 } },
        });
      }

      await tx.$executeRaw(Prisma.sql`UPDATE "ad_serve_grants" SET "eventMask" = "eventMask" | ${bit} WHERE "id" = ${verdict.payload.i}`);
      await tx.adEvent.create({
        data: {
          tenantId: campaign.tenantId,
          campaignId, creativeId, placementKey, eventType: ev.eventType,
          userHash: currentUserHash, sessionId, occurredAt, tokenHash: th,
          authorityVersion: 2,
          meta: { ...(ev.meta ?? {}), authorityVersion: 2 } as never,
        },
      });
      return 'accepted';
    });
  }

  private safeDate(iso: string, fallback: Date): Date {
    const d = new Date(iso);
    // Drop events older than 24h or in the future (client-clock guard).
    if (Number.isNaN(d.getTime()) || d < new Date(fallback.getTime() - 24 * 3_600_000) || d > new Date(fallback.getTime() + 60_000)) {
      return fallback;
    }
    return d;
  }
}
