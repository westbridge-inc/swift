import type { PrismaClient, AdEventType, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { verifyImpressionToken } from './ads-token';

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

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class AdEventService {
  constructor(private prisma: PrismaClient) {}

  /** Ingest a batch (≤50). Per-item verdict, in order. `userHash` is the
   *  server-derived pseudonymous key (null for anonymous sessions). */
  async ingest(events: IncomingEvent[], userHash: string | null, now = new Date()): Promise<EventVerdict[]> {
    const verdicts: EventVerdict[] = [];
    for (const ev of events) {
      verdicts.push(await this.ingestOne(ev, userHash, now));
    }
    return verdicts;
  }

  private async ingestOne(ev: IncomingEvent, userHash: string | null, now: Date): Promise<EventVerdict> {
    const verdict = verifyImpressionToken(ev.token, now.getTime());
    if (!verdict.ok) return 'invalid';
    const { c: campaignId, r: creativeId, p: placementKey, s: sessionId } = verdict.payload;
    const th = tokenHash(ev.token);

    // Dedupe: insert-on-conflict. A duplicate (same token + type) drops silently.
    try {
      await this.prisma.adEventDedupe.create({ data: { tokenHash: th, eventType: ev.eventType } });
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') return 'duplicate';
      throw err;
    }

    // Freq counter on viewable impressions only (§12.2), keyed by userHash+day.
    if (ev.eventType === VIEWABLE && userHash) {
      const day = new Date(now.toISOString().slice(0, 10));
      await this.prisma.adFreqCounter.upsert({
        where: { userHash_placementKey_day: { userHash, placementKey, day } },
        create: { userHash, placementKey, day, count: 1 },
        update: { count: { increment: 1 } },
      });
    }

    const occurredAt = this.safeDate(ev.occurredAt, now);
    // AdEvent tenant follows the campaign; single-tenant V1 defaults align.
    const campaign = await this.prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { tenantId: true } });
    await this.prisma.adEvent.create({
      data: {
        tenantId: campaign?.tenantId ?? 'swift-default',
        campaignId, creativeId, placementKey, eventType: ev.eventType,
        userHash: userHash ?? null, sessionId, occurredAt, tokenHash: th,
        meta: (ev.meta ?? undefined) as never,
      },
    });
    return 'accepted';
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
