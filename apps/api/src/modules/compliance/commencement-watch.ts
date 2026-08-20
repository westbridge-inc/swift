import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * [DCR-1 Part III] The Commencement Watch.
 *
 * Guyana's DPA takes effect only when a commencement order appears in the
 * Official Gazette. This watch exists to notice that (and its satellites —
 * Regulations, an Office/Commissioner, a registration portal) within hours,
 * alert a channel that reaches the founder, and DEGRADE LOUDLY when it
 * cannot see. Prime directive: the watch OBSERVES AND ALERTS, never acts —
 * no app behavior changes, no legal state moves (only the founder-signed
 * CLI does that).
 */

export interface WatchSource {
  id: string;
  url: string;
  /** Only S1 (the Gazette itself) can mint CONFIRMED-CANDIDATE. */
  trust: 'S1' | 'S2' | 'S3';
  /** [F-022-01] A listing page that "succeeds" with fewer real entries than
   *  this floor is PARSE_THIN — nav-link scraps must never count as sight. */
  minEntries?: number;
}

export interface GazetteEntry {
  title: string;
  url: string | null;
}

export interface WatchHit {
  entry: GazetteEntry;
  eventType: 'COMMENCEMENT' | 'REGULATIONS' | 'OFFICE_NEWS' | 'REGISTRATION_OPEN';
  confidence: 'CONFIRMED-CANDIDATE' | 'SIGNAL';
  matchedRule: string;
}

export const WATCH_SOURCES: WatchSource[] = [
  { id: 'gazette-publications', url: 'https://officialgazette.gov.gy/publications/', trust: 'S1' },
  { id: 'gazette-search-dpa', url: 'https://officialgazette.gov.gy/?s=Data+Protection', trust: 'S1' },
  { id: 'parliament-acts', url: 'https://www.parliament.gov.gy/publications/acts-of-parliament', trust: 'S2' },
];

/** Detection rules over NORMALIZED titles (lowercase, single-spaced).
 *  The canonical NEGATIVE: "Order No. 73 of 2026 - The Digital Identity Card
 *  Act 2023 (Commencement) Order 2026" must never fire — every rule requires
 *  the words "data protection". */
const RULES: { id: string; re: RegExp; eventType: WatchHit['eventType'] }[] = [
  { id: 'R1', re: /data\s+protection\s+act.*\bcommencement\b/, eventType: 'COMMENCEMENT' },
  { id: 'R2', re: /order\s+no\.?\s*\d+\s+of\s+20\d\d.*data\s+protection/, eventType: 'COMMENCEMENT' },
  { id: 'R3', re: /data\s+protection.*regulations/, eventType: 'REGULATIONS' },
  { id: 'R4', re: /data\s+protection.*(office|commission(er)?)/, eventType: 'OFFICE_NEWS' },
  { id: 'R5', re: /registration\s+of\s+(data\s+)?controllers|data\s+(controller|processor).*regist/, eventType: 'REGISTRATION_OPEN' },
];

/** S1 × (R1|R2|R3|R5) → CONFIRMED-CANDIDATE (still human-verified before
 *  anything changes); everything else is a SIGNAL. */
const CONFIRMABLE = new Set(['R1', 'R2', 'R3', 'R5']);

export function normalizeTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Anchor extraction good enough for listing pages: `<a href>text</a>` pairs
 *  plus bare list-item text. No DOM dependency — parse failures surface as
 *  PARSE_EMPTY, which is a FAILURE, never a quiet zero. */
export function parseEntries(html: string): GazetteEntry[] {
  const out: GazetteEntry[] = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const title = m[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length >= 8) out.push({ title, url: m[1]! });
  }
  return out;
}

export function classify(entry: GazetteEntry, trust: WatchSource['trust']): WatchHit | null {
  const t = normalizeTitle(entry.title);
  for (const rule of RULES) {
    if (rule.re.test(t)) {
      const confirmed = trust === 'S1' && CONFIRMABLE.has(rule.id);
      return {
        entry,
        eventType: rule.eventType,
        confidence: confirmed ? 'CONFIRMED-CANDIDATE' : 'SIGNAL',
        matchedRule: rule.id,
      };
    }
  }
  return null;
}

export function contentHash(sourceId: string, hit: WatchHit): string {
  return createHash('sha256')
    .update(`${sourceId}|${hit.eventType}|${normalizeTitle(hit.entry.title)}`)
    .digest('hex');
}

export type FetchLike = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScanSummary {
  sourceId: string;
  status: number | null;
  entries: number;
  newAlerts: number;
  error: string | null;
}

/** One full scan of every source: fetch → parse → classify → dedup-insert,
 *  one cw_runs receipt per source. Degradation: 3 consecutive failing runs of
 *  a source raise ONE WATCH_DEGRADED (SYSTEM) per 24h until healthy. */
export async function runScan(
  prisma: PrismaClient,
  fetchImpl: FetchLike,
  sources: WatchSource[] = WATCH_SOURCES,
): Promise<ScanSummary[]> {
  const summaries: ScanSummary[] = [];
  for (const source of sources) {
    let status: number | null = null;
    let error: string | null = null;
    let entries: GazetteEntry[] = [];
    let listingHash: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetchImpl(source.url, {
          signal: controller.signal,
          headers: { 'user-agent': 'SwiftComplianceWatch/1.0 (compliance watch)' },
        });
        status = res.status;
        if (res.status !== 200) {
          error = `HTTP_${res.status}`;
        } else {
          const html = await res.text();
          listingHash = createHash('sha256').update(html).digest('hex');
          entries = parseEntries(html);
          const floor = source.minEntries ?? 5;
          if (entries.length === 0) error = 'PARSE_EMPTY';
          else if (entries.length < floor) error = `PARSE_THIN:${entries.length}<${floor}`;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error = err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : `FETCH_FAILED:${(err as Error)?.message ?? 'unknown'}`;
    }

    let newAlerts = 0;
    for (const entry of entries) {
      const hit = classify(entry, source.trust);
      if (!hit) continue;
      const hash = contentHash(source.id, hit);
      const created = await prisma.cwAlert.createMany({
        data: [{
          eventType: hit.eventType,
          confidence: hit.confidence,
          sourceId: source.id,
          matchedRule: hit.matchedRule,
          entryTitle: hit.entry.title,
          entryUrl: hit.entry.url,
          contentHash: hash,
        }],
        skipDuplicates: true, // dedupe on contentHash across scans
      });
      newAlerts += created.count;
    }

    await prisma.cwRun.create({
      data: {
        sourceId: source.id, httpStatus: status, listingHash,
        entriesSeen: entries.length, hits: newAlerts, error,
      },
    });
    summaries.push({ sourceId: source.id, status, entries: entries.length, newAlerts, error });

    if (error) await maybeRaiseDegradation(prisma, source.id);
  }
  return summaries;
}

/** 3 consecutive failing runs → one WATCH_DEGRADED (SYSTEM) per 24h. */
async function maybeRaiseDegradation(prisma: PrismaClient, sourceId: string): Promise<void> {
  const lastRuns = await prisma.cwRun.findMany({
    where: { sourceId }, orderBy: { ranAt: 'desc' }, take: 3, select: { error: true },
  });
  if (lastRuns.length < 3 || !lastRuns.every((r) => r.error !== null)) return;
  const dayBucket = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
  const hash = createHash('sha256').update(`degraded|${sourceId}|${dayBucket}`).digest('hex');
  await prisma.cwAlert.createMany({
    data: [{
      eventType: 'WATCH_DEGRADED', confidence: 'SYSTEM', sourceId,
      matchedRule: 'DEGRADED_3X', entryTitle: `Watch source ${sourceId} failing 3+ consecutive scans`,
      entryUrl: null, contentHash: hash,
    }],
    skipDuplicates: true,
  });
}

export interface NotifyChannels {
  webhookUrl: string | null;
  /** Parsed for forward-compat; NOT yet a delivery channel — email sending is
   *  unimplemented, so configured emails alone do NOT satisfy has-channel
   *  [F-022-03 honesty]. */
  emails: string[];
  /** In-app admin notify — must RESOLVE TO THE NUMBER OF HUMANS REACHED. */
  notifyAdmins: ((title: string, body: string) => Promise<number>) | null;
}

export function channelsFromEnv(notifyAdmins: NotifyChannels['notifyAdmins']): NotifyChannels {
  const emails = (process.env['CW_ALERT_EMAILS'] ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  return {
    webhookUrl: process.env['CW_ALERT_WEBHOOK_URL'] || null,
    emails,
    notifyAdmins,
  };
}

/** Deliver unnotified alerts; the big three re-notify daily until a human
 *  acknowledges. ZERO configured channels is itself a RED condition: the
 *  entire watch exists to reach a human, so it throws (job goes RED) after
 *  recording a SYSTEM alert. */
export async function notifyPending(
  prisma: PrismaClient,
  channels: NotifyChannels,
  fetchImpl: FetchLike,
): Promise<number> {
  // Only channels that can actually DELIVER count (emails: parsed, not sent).
  const hasChannel = !!channels.webhookUrl || !!channels.notifyAdmins;
  if (!hasChannel) {
    const dayBucket = new Date().toISOString().slice(0, 10);
    await prisma.cwAlert.createMany({
      data: [{
        eventType: 'WATCH_DEGRADED', confidence: 'SYSTEM', sourceId: 'notify',
        matchedRule: 'NO_CHANNEL', entryTitle: 'CW has ZERO alert channels configured — alerts cannot reach a human',
        entryUrl: null, contentHash: createHash('sha256').update(`nochannel|${dayBucket}`).digest('hex'),
      }],
      skipDuplicates: true,
    });
    throw new Error('[DCR-1 CW] zero alert channels configured (CW_ALERT_WEBHOOK_URL / CW_ALERT_EMAILS) — the watch cannot reach a human');
  }

  const reNotifyBefore = new Date(Date.now() - DAY_MS);
  const pending = await prisma.cwAlert.findMany({
    where: {
      OR: [
        { notifiedAt: null },
        {
          acknowledgedBy: null,
          eventType: { in: ['COMMENCEMENT', 'REGULATIONS', 'REGISTRATION_OPEN'] },
          notifiedAt: { lt: reNotifyBefore },
        },
      ],
    },
    orderBy: { firstSeenAt: 'asc' },
  });
  let undelivered = 0;
  for (const alert of pending) {
    const title = `[DPA WATCH · ${alert.confidence}] ${alert.eventType}`;
    const body = `${alert.entryTitle}${alert.entryUrl ? ` — ${alert.entryUrl}` : ''} (rule ${alert.matchedRule}, source ${alert.sourceId})`;
    // [F-022-03] notifiedAt is stamped only on PROVEN delivery: a 2xx webhook
    // response, or ≥1 admin recipient actually notified. Anything less leaves
    // the alert pending for the next cycle — and an all-fail cycle goes RED.
    let delivered = false;
    if (channels.webhookUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          const res = await fetchImpl(channels.webhookUrl, {
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            // @ts-expect-error minimal fetch-like: POST body tolerated by real fetch
            method: 'POST', body: JSON.stringify({ title, body, alertId: alert.id }),
          });
          if (res.status >= 200 && res.status < 300) delivered = true;
        } finally {
          clearTimeout(timer);
        }
      } catch { /* webhook failure must not block the in-app channel */ }
    }
    if (channels.notifyAdmins) {
      const reached = await channels.notifyAdmins(title, body).catch(() => 0);
      if (reached > 0) delivered = true;
    }
    if (delivered) {
      await prisma.cwAlert.update({ where: { id: alert.id }, data: { notifiedAt: new Date() } });
    } else {
      undelivered += 1;
    }
  }
  if (pending.length > 0 && undelivered === pending.length) {
    throw new Error(`[DCR-1 CW] ${undelivered} alert(s) pending and NO channel delivered — the watch is not reaching a human`);
  }
  return pending.length - undelivered;
}
