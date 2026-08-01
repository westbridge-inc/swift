import type { PrismaClient } from '@prisma/client';
import { mondayOf } from './ads-weeks';
import { signImpressionToken } from './ads-token';

// Ad serving (ads-platform spec §11). One batched endpoint builds the home
// screen's ad slots. The cardinal rule: ADS NEVER BREAK THE HOME SCREEN — empty
// inventory falls back to house ads, no house ads collapses the slot, and any
// failure degrades to empty. Every served item carries the advertiser name so
// the client renders the mandatory "Ad · {Company}" label, and an impression
// token so its stats are billable (§11.3).

const POOL_TTL_MS = 300_000; // 5 min (§11.2)

interface ServeItem {
  campaignId: string;
  creativeId: string;
  kind: 'IMAGE' | 'VIDEO';
  mediaUrl: string;
  posterUrl: string | null;
  headline: string | null;
  advertiserName: string;
  ctaLabel: string | null;
  destination: { type: string; value: string | null };
  impressionToken?: string; // absent for house ads (not tracked)
}

interface PlacementSlot {
  rotationSeconds: number | null;
  ttlSeconds: number;
  items: ServeItem[];
}

/** FNV-1a — a cheap, stable hash for the per-user rotation start (§11.2). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rotateStart<T>(items: T[], seed: number): T[] {
  if (items.length <= 1) return items;
  const start = seed % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** In-process TTL cache. Single-instance-correct now; the interface is Redis-
 *  shaped so a distributed cache drops in for multi-instance later. */
class TtlCache<V> {
  private store = new Map<string, { v: V; exp: number }>();
  get(key: string, now: number): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.exp < now) { this.store.delete(key); return undefined; }
    return e.v;
  }
  set(key: string, v: V, ttlMs: number, now: number): V {
    this.store.set(key, { v, exp: now + ttlMs });
    return v;
  }
  invalidatePrefix(prefix: string): void {
    for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k);
  }
}

export class AdServingService {
  private static poolCache = new TtlCache<ServeItem[]>();

  constructor(private prisma: PrismaClient) {}

  /** Invalidate a tenant's pools (called on confirm/pause/kill/approve). */
  static invalidateTenant(tenantId: string): void {
    AdServingService.poolCache.invalidatePrefix(`${tenantId}:`);
  }

  async serve(input: {
    tenantId: string;
    city: string;
    sessionId: string;
    userHash: string | null;
    keys: string[];
  }, now = new Date()): Promise<{ placements: Record<string, PlacementSlot>; _house: Record<string, boolean> }> {
    const week = mondayOf(now, 'America/Guyana');
    const placements: Record<string, PlacementSlot> = {};
    const house: Record<string, boolean> = {};
    const dayBucket = now.toISOString().slice(0, 10);
    const hourBucket = now.toISOString().slice(0, 13);

    for (const key of input.keys) {
      const placement = await this.prisma.adPlacement.findUnique({ where: { tenantId_key: { tenantId: input.tenantId, key } } });
      if (!placement || !placement.active) continue;

      const cacheKey = `${input.tenantId}:${key}:${input.city}:${week.toISOString().slice(0, 10)}`;
      let pool = AdServingService.poolCache.get(cacheKey, now.getTime());
      if (!pool) {
        pool = await this.loadPool(placement.id, input.city, week);
        AdServingService.poolCache.set(cacheKey, pool, POOL_TTL_MS, now.getTime());
      }

      let items = pool;
      let isHouse = false;
      if (items.length === 0) {
        items = await this.loadHouseAds(input.tenantId, placement.id);
        isHouse = items.length > 0;
      }

      // Frequency cap (viewable-impression based) — capped-out users fall to
      // house ads when nothing else remains.
      if (!isHouse && placement.freqCapPerUserPerDay && input.userHash) {
        items = await this.filterByFreqCap(items, input.userHash, key, dayBucket, placement.freqCapPerUserPerDay);
        if (items.length === 0) {
          const houseFallback = await this.loadHouseAds(input.tenantId, placement.id);
          if (houseFallback.length > 0) { items = houseFallback; isHouse = true; }
        }
      }

      // Fairness: the start position varies per user per hour.
      items = rotateStart(items, fnv1a(`${input.userHash ?? input.sessionId}:${hourBucket}`));

      const maxItems = key === 'home_ad_bar' ? placement.slotsPerWeek : 1;
      const shaped = items.slice(0, maxItems).map((it) => this.attachToken(it, key, input.sessionId, isHouse, now.getTime()));

      placements[key] = { rotationSeconds: placement.rotationSeconds ?? null, ttlSeconds: Math.floor(POOL_TTL_MS / 1000), items: shaped };
      if (isHouse) house[key] = true;
    }
    return { placements, _house: house };
  }

  /** loadPool (§11.2): CONFIRMED bookings for (city OR "*") this week ∩ campaign
   *  LIVE ∩ latest APPROVED+READY creative → one entry per booked slot. */
  private async loadPool(placementId: string, city: string, week: Date): Promise<ServeItem[]> {
    const bookings = await this.prisma.adBooking.findMany({
      where: {
        placementId, weekStart: week, status: 'CONFIRMED',
        city: { in: [city, '*'] },
        campaign: { status: 'LIVE' },
      },
      include: {
        campaign: {
          select: {
            id: true, destinationType: true, destinationValue: true,
            advertiser: { select: { companyName: true } },
            creatives: { where: { status: 'APPROVED', transcodeStatus: 'READY' }, orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });
    const items: ServeItem[] = [];
    for (const b of bookings) {
      const creative = b.campaign.creatives[0];
      if (!creative) continue; // no approved creative → can't serve this booking
      items.push({
        campaignId: b.campaign.id,
        creativeId: creative.id,
        kind: creative.kind,
        mediaUrl: creative.fileUrl,
        posterUrl: creative.posterUrl,
        headline: creative.headline,
        advertiserName: b.campaign.advertiser.companyName,
        ctaLabel: creative.ctaLabel,
        destination: { type: b.campaign.destinationType, value: b.campaign.destinationValue },
      });
    }
    return items;
  }

  private async loadHouseAds(tenantId: string, placementId: string): Promise<ServeItem[]> {
    const rows = await this.prisma.houseAd.findMany({ where: { tenantId, placementId, active: true }, orderBy: { sort: 'asc' } });
    return rows.map((h) => ({
      campaignId: `house:${h.id}`, creativeId: `house:${h.id}`, kind: h.kind,
      mediaUrl: h.fileUrl, posterUrl: h.posterUrl, headline: h.headline,
      advertiserName: 'Swift', ctaLabel: h.ctaLabel,
      destination: { type: h.destinationType, value: h.destinationValue },
    }));
  }

  private async filterByFreqCap(items: ServeItem[], userHash: string, placementKey: string, dayBucket: string, cap: number): Promise<ServeItem[]> {
    const counter = await this.prisma.adFreqCounter.findUnique({ where: { userHash_placementKey_day: { userHash, placementKey, day: new Date(dayBucket) } } });
    if (counter && counter.count >= cap) return [];
    return items;
  }

  private attachToken(item: ServeItem, placementKey: string, sessionId: string, isHouse: boolean, now: number): ServeItem {
    if (isHouse) return item; // house ads are not tracked (§11.1)
    return { ...item, impressionToken: signImpressionToken({ c: item.campaignId, r: item.creativeId, p: placementKey, s: sessionId }, now) };
  }
}
