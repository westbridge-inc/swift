import { Prisma, type PrismaClient, type AdEventType } from '@prisma/client';
import { createHash } from 'node:crypto';
import { adTokenMatchesPrincipal, userHash, verifyImpressionToken } from './ads-token';

// Ad event ingestion (ads-platform spec §12.2). The anti-fraud core: an event
// is only counted if its impression token verifies (HMAC + expiry) — a token
// never issued by a real serve is impossible to forge. Then dedupe (one event
// per token per type), increment the frequency counter on viewable
// impressions, and insert the billing-grade AdEvent. Raw user ids never enter
// AdEvent — only the daily-rotating userHash. Postgres is the source of truth.

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
    if (!verdict.ok) return 'invalid';
    // A token issued to user A can never acquire user B's attribution, and a
    // guest token stays guest-only. This check precedes dedupe/frequency writes
    // so a rejected replay cannot consume the legitimate event.
    if (!adTokenMatchesPrincipal(verdict.payload, principal.userId, principal.authPresented)) return 'invalid';
    const { c: campaignId, r: creativeId, p: placementKey, s: sessionId } = verdict.payload;
    const th = tokenHash(ev.token);
    const currentUserHash = principal.userId ? userHash(principal.userId, now.toISOString().slice(0, 10)) : null;

    const occurredAt = this.safeDate(ev.occurredAt, now);

    // Campaign authority, the exact dedupe claim, frequency mutation, and the
    // billing-grade event are one commit. FOR KEY SHARE makes a concurrently
    // deleted campaign wait until this event commits; an already-missing
    // campaign is invalid and can never fall through to a default tenant.
    return this.prisma.$transaction(async (tx): Promise<EventVerdict> => {
      const campaigns = await tx.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
        SELECT "tenantId"
        FROM "ad_campaigns"
        WHERE "id" = ${campaignId}
        FOR KEY SHARE
      `);
      const campaign = campaigns[0];
      if (!campaign) return 'invalid';

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

      await tx.adEvent.create({
        data: {
          tenantId: campaign.tenantId,
          campaignId, creativeId, placementKey, eventType: ev.eventType,
          userHash: currentUserHash, sessionId, occurredAt, tokenHash: th,
          meta: (ev.meta ?? undefined) as never,
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
