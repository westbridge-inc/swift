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

/** [F-024-07 → F-026-03] Does an anchor title look like a gazette PUBLICATION
 *  rather than site chrome?
 *
 *  The first attempt accepted any ONE of: a legal word, an instrument number,
 *  or a year. That was still trivially gameable, because on a LEGAL site the
 *  nav bar is made of exactly those words — "Acts", "Bills", "Notices",
 *  "Regulations", "Official Gazette" — so five category links cleared the
 *  floor with zero publications behind them.
 *
 *  The second attempt required an instrument word AND (a number OR a year).
 *  "Act Archive 2026", "Bill Tracker 2026", "Regulation Index 2026" — five
 *  plausible year-scoped category links on any Gazette site — cleared it with
 *  zero publications behind them. [F-027-01]
 *
 *  Third shape, and a different one rather than another conjunct:
 *    · CATEGORY VOCABULARY DISQUALIFIES. Archive/index/tracker/directory names
 *      a place where publications are kept, not a publication.
 *    · A number or a full date IS identity.
 *    · A bare year — the signal navigation reaches for — counts only on a
 *      title long enough to be a real instrument name.
 *
 *  Honest about what this is: still a heuristic on a short string, and two
 *  previous versions looked airtight to me too. So the test for it is no
 *  longer one chosen vocabulary set — it GENERATES the navigation space
 *  (instrument word × category word × year/number) and requires that none of
 *  it passes. That is the claim the reviewer actually asked for.
 *
 *  Deliberately biased toward UNDER-counting: a false PARSE_THIN is noisy,
 *  visible and harmless, while over-counting is a false clean bill of health
 *  on a dead feed — the exact failure this gate exists to prevent. The real
 *  backstop is not this predicate: it is WATCH_DEGRADED plus the founder's
 *  weekly Gazette calendar check. */
/** Words that describe a PLACE WHERE publications are kept, not a publication.
 *  Any one of them makes a title navigation, whatever else it contains: this is
 *  what defeated attempt two, where "Act Archive 2026" cleared a floor built
 *  from "instrument word AND (number OR year)" — one instrument token, one
 *  year, zero publications. Year-scoped category links are the natural
 *  navigation of a legal site, so the vocabulary of CATEGORIES has to be a
 *  disqualifier in its own right. */
const NAVIGATION_WORDS = /\b(archive|archives|index|indexes|tracker|listing|listings|browse|search|home|contact|about|category|categories|section|sections|library|collection|collections|database|records|resources|downloads|papers|portal|menu|navigation|nav|overview|directory|catalogue|catalog|repository|bulletin\s?board|all\b|more\b|page|pages|latest|recent|archive\s?index)\b/;

/** Publications carry an identity a category never does. Either an explicit
 *  instrument number, or a full date — or a year attached to a title long
 *  enough to be a real instrument name rather than a two-word label. */
const HAS_NUMBER = /\bno\.?\s*\d+/;
const HAS_FULL_DATE = /\b\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(19|20)\d\d\b/;
const HAS_YEAR = /\b(19|20)\d\d\b/;
const NAMES_AN_INSTRUMENT = /\b(act|order|bill|notice|regulation|regulations|gazette|supplement|extraordinary|proclamation|resolution)\b/;

/** [F-028-09] What may follow the LAST instrument token in a real citation:
 *  numbers, dates, years, parentheticals, punctuation — QUALIFIERS, never
 *  prose. "The Fisheries (Amendment) Act 2026" ends in qualifiers; "Bill
 *  Status in the National Assembly 2026" continues in prose. */
const CITATION_TAIL = new RegExp(
  '^(?:\\s*(?:\\(.*?\\)|no\\.?\\s*\\d+[a-z]?|[a-z]\\b|of\\s+(?:19|20)\\d\\d|(?:19|20)\\d\\d(?:[\u2013-](?:19|20)?\\d{1,4})?|' +
  '\\d{1,2}\\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\\s+(?:19|20)\\d\\d)?|' +
  '[,;:.\u2014\u2013-]))*\\s*$',
);

const INSTRUMENT_TOKEN = /\b(act|order|bill|notice|regulation|regulations|gazette|supplement|extraordinary|proclamation|resolution)\b/g;

export function looksLikePublication(title: string): boolean {
  const t = normalizeTitle(title);

  // A category label is navigation no matter how legal its other words are.
  if (NAVIGATION_WORDS.test(t)) return false;
  if (!NAMES_AN_INSTRUMENT.test(t)) return false;

  // [F-028-09] THE CLASS FIX. Three rounds of this predicate fell to the same
  // shape: a vocabulary blocklist, defeated by vocabulary outside it ("Bill
  // Status in the National Assembly 2026" — five words, an instrument token,
  // a year, no blocked word). Word lists cannot win that game, so the rule is
  // now STRUCTURAL: a real title is a CITATION — a name, then its instrument
  // token, then nothing but qualifiers (a number, a date, a year, brackets).
  // A navigation title is a SENTENCE — its instrument token sits mid-prose
  // ("Regulations Issued BY the Ministry DURING 2026"), so something other
  // than a qualifier follows it. Position and grammar, not vocabulary: a new
  // noun cannot fake a citation tail, whatever it is.
  //
  // The deliberate cost: an inverted citation ("Act No. 5 of 2026 — Fisheries
  // Amendment") is rejected. The floor counts entries across a whole feed, so
  // a rare miss UNDERCOUNTS — and an undercount trips WATCH_DEGRADED, which a
  // human reads. Failing loud beats a nav shell counting as a healthy scan.
  // Dashes join a citation to its descriptive half ("Order No. 12 of 2026 —
  // Municipal Fees", "No. 73 of 2026 - The ... Order 2026"): ANY segment being
  // a well-formed citation is enough, because the identity is established
  // there and the rest is its label. A navigation sentence has no such
  // segment — its instrument token continues into prose on every side of any
  // dash it contains.
  const segments = t.split(/\s+[\u2014\u2013-]\s+/);
  const isCitationSegment = (seg: string): boolean => {
    INSTRUMENT_TOKEN.lastIndex = 0;
    let lastEnd = -1;
    for (let m = INSTRUMENT_TOKEN.exec(seg); m; m = INSTRUMENT_TOKEN.exec(seg)) lastEnd = m.index + m[0].length;
    if (lastEnd < 0) return false;
    return CITATION_TAIL.test(seg.slice(lastEnd));
  };
  if (!segments.some(isCitationSegment)) return false;

  // An explicit number or a full date is identity on its own.
  if (HAS_NUMBER.test(t) || HAS_FULL_DATE.test(t)) return true;

  // A bare year is the weakest signal and the one navigation reaches for, so
  // it only counts on a title with the substance of a real instrument name
  // ("The Fisheries (Amendment) Act 2026" — not "Bill Tracker 2026").
  const words = t.split(/\s+/).filter((w) => /[a-z0-9]/.test(w));
  return HAS_YEAR.test(t) && words.length >= 5;
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
          // [F-024-07] the health floor counts PUBLICATION-shaped entries, not
          // raw anchors — nav-link-only pages are an unhealthy feed.
          const publicationShaped = entries.filter((e) => looksLikePublication(e.title)).length;
          if (entries.length === 0) error = 'PARSE_EMPTY';
          else if (publicationShaped < floor) error = `PARSE_THIN:${publicationShaped}<${floor}`;
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
  /** [F-024-04] How many humans the notifyAdmins channel COULD reach right
   *  now (active admin count), without sending. The function's mere presence
   *  is not a channel: with zero active admins and no pending alerts the old
   *  check stayed green for months while the watch reached nobody. Optional
   *  for callers that predate it (absence = presence-of-function semantics). */
  probeAdmins?: (() => Promise<number>) | null;
}

export function channelsFromEnv(
  notifyAdmins: NotifyChannels['notifyAdmins'],
  probeAdmins?: NotifyChannels['probeAdmins'],
): NotifyChannels {
  const emails = (process.env['CW_ALERT_EMAILS'] ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  return {
    webhookUrl: process.env['CW_ALERT_WEBHOOK_URL'] || null,
    emails,
    notifyAdmins,
    probeAdmins: probeAdmins ?? null,
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
  // [F-024-04] The in-app channel counts only if it can reach ≥1 active admin
  // RIGHT NOW — probed every cycle, so a zero-admin deployment goes RED on the
  // next run even with no pending alerts, instead of sitting green for months.
  const adminReachable = channels.notifyAdmins
    ? channels.probeAdmins
      ? await channels.probeAdmins().catch(() => 0)
      : 1 // no probe supplied (legacy caller): keep presence-of-function semantics
    : 0;
  const hasChannel = !!channels.webhookUrl || adminReachable > 0;
  if (!hasChannel) {
    const noAdmins = !!channels.notifyAdmins && adminReachable === 0;
    const rule = noAdmins ? 'NO_REACHABLE_ADMIN' : 'NO_CHANNEL';
    const dayBucket = new Date().toISOString().slice(0, 10);
    await prisma.cwAlert.createMany({
      data: [{
        eventType: 'WATCH_DEGRADED', confidence: 'SYSTEM', sourceId: 'notify',
        matchedRule: rule,
        entryTitle: noAdmins
          ? 'CW in-app channel reaches ZERO active admins and no webhook is configured — alerts cannot reach a human'
          : 'CW has ZERO alert channels configured — alerts cannot reach a human',
        entryUrl: null, contentHash: createHash('sha256').update(`${rule.toLowerCase()}|${dayBucket}`).digest('hex'),
      }],
      skipDuplicates: true,
    });
    throw new Error(noAdmins
      ? '[DCR-1 CW] the in-app channel reaches zero active admins and no webhook is configured — the watch cannot reach a human'
      : '[DCR-1 CW] zero alert channels configured (CW_ALERT_WEBHOOK_URL / CW_ALERT_EMAILS) — the watch cannot reach a human');
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
