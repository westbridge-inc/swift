// ---------------------------------------------------------------------------
// Movement R — R9: the actor's Standing view, computed in ONE place and served
// through thin per-role routes (vendor/rider/driver/provider /standing).
// RAT-G anonymity law: everything actor-facing is DAILY-FOLDED — aggregates,
// trend and tag counts read only ratings older than the last fold, so a single
// fresh rating can never be traced to this morning's customer. The fold
// timestamp is stamped by the 'rating-actor-fold' daily job; before the first
// stamp the boundary is the UTC start of today (same guarantee, by math).
// R-Law 3 stays intact: this file COMPUTES a view; it never acts on one.
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';
import { TYPES_FOR_ROLE, type SubjectRef } from './rating-stats.service';
import { surfaceOf, NEW_ACTOR_SURFACE, type RatingSurface } from './rating-surface';
import { getTenantId } from '../../plugins/tenant-context';
import { RATING_GROUP_SIZE, groupRatings, shownRating, type PersonRatingRole } from './rating-groups';

type Role = SubjectRef['role'];

/** One line per negative tag — shown on the coaching card at ATTENTION/AT_RISK.
 *  Tone law (spec R9 copy): practical, warm, zero threats — the founder decides
 *  consequences, not copy. */
const COACHING: Record<Role, Record<string, string>> = {
  VENDOR: {
    'missing-items': 'Double-check every bag against the order screen before handover — missing items are the #1 reason customers stop ordering.',
    'wrong-item': 'Read the order line by line as you pack — a ten-second check beats a remake.',
    'cold-food': "Mark the order ready only when it's actually packed, so the rider arrives to a hot handoff.",
    'poor-packaging': 'Seal containers and bag sauces separately — packaging is the last thing you control and the first thing they see.',
    'long-wait': 'Keep your prep time honest in the app — customers forgive a long quote, not a broken one.',
    'not-as-described': 'Update photos and descriptions when a dish changes — the listing is a promise.',
  },
  RIDER: {
    late: 'Mark yourself arrived as soon as you reach — customers rate the wait, not the ride.',
    rude: 'A hello at handover and a thanks at the door carry the whole rating — keep it warm.',
    'rough-handling': 'Keep bags flat and sealed in the box, so it arrives like it was packed.',
    'handover-issue': 'Follow the pickup-code flow every time — codes protect you as much as the customer.',
  },
  DRIVER: {
    'unsafe-driving': 'Smooth beats fast — passengers rate how safe the ride felt, not the minutes saved.',
    'vehicle-condition': 'A quick daily clean and working seat belts keep this tag away.',
    'late-pickup': "Head to the pin as soon as you accept — if you're delayed, let the honest ETA speak.",
    rude: 'Greet by name and confirm the destination — two sentences that carry the stars.',
    'long-route': "Follow the suggested route, or say why you're deviating — surprises read as overcharging.",
  },
  SERVICE_PROVIDER: {
    'poor-quality': "Walk the finished job with the customer before you leave — agree it's done, and done right.",
    'late-noshow': "If you'll be late, say so in chat before the window opens — silence is what gets rated.",
    overcharged: 'Quote the full price before you start — changes get agreed, never sprung.',
    unprofessional: 'Show up as the business you want to be — presentation is part of the work.',
    'left-mess': "Leave the space cleaner than you found it — it's the last thing they see.",
  },
  CUSTOMER: {}, // customers get an aggregate row, never a coaching card
};

export interface StandingView extends RatingSurface {
  standing: string;
  /** The fold boundary the whole view honours (RAT-G). */
  foldedAt: string;
  folded: { count: number; average: number | null };
  /** 13 weekly buckets ending at the fold — the 90-day sparkline. For a PERSON (not a store): the last 13
   *  whole groups of 5 ratings instead (weekStart = the day the group's first rating was given). */
  trend: Array<{ weekStart: string; average: number | null; count: number }>;
  /** Set for a person: every figure here is over whole groups of this many ratings (rating-groups.ts). */
  groupSize?: number;
  topPositive: Array<{ tag: string; label: string; count: number }>;
  topNegative: Array<{ tag: string; label: string; count: number }>;
  coaching: Array<{ tag: string; label: string; line: string }>;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const WEEK_MS = 7 * 24 * 3600_000;

/**
 * [COORD 18 Oct, option S] A PERSON's Standing (rider, driver, provider, customer): every figure is built from
 * the one partition, whole groups of 5 final ratings (rating-groups.ts), so it moves only when a whole new group
 * lands and no rating can be matched to one trip. Stores keep the daily-folded view below (their reviews page
 * lists each review anyway).
 */
async function personStandingView(prisma: PrismaClient, role: PersonRatingRole, userId: string): Promise<StandingView> {
  const rows = await prisma.rating.findMany({
    where: { rateeId: userId, type: { in: TYPES_FOR_ROLE[role] as never }, state: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { score: true, tags: true, createdAt: true, editableUntil: true },
  });
  const grouped = groupRatings(rows);
  const shown = shownRating(grouped, role);
  const { topPositive, topNegative } = await rankedTags(prisma, role, grouped.rows);
  const last = grouped.groups[grouped.groups.length - 1];
  return {
    standing: shown.standing,
    displayRating: shown.displayRating, ratingBucket: shown.ratingBucket, ratingCount: shown.ratingCount, topRated: shown.topRated,
    foldedAt: (last?.to ?? startOfUtcDay(new Date())).toISOString(),
    folded: { count: grouped.count, average: grouped.average },
    trend: grouped.groups.slice(-13).map((g) => ({ weekStart: g.from.toISOString().slice(0, 10), average: g.average, count: g.count })),
    topPositive,
    topNegative,
    coaching: coachingFor(role, shown.standing, topNegative),
    groupSize: RATING_GROUP_SIZE,
  };
}

/** Tag counts over the given rows, labelled + split by the seeded taxonomy. */
async function rankedTags(prisma: PrismaClient, role: Role, rows: ReadonlyArray<{ tags: string[] }>) {
  const defs = await prisma.ratingTagDef.findMany({ where: { role } });
  const bySlug = new Map(defs.map((d) => [d.slug, d]));
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const ranked = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, def: bySlug.get(tag) }))
    .filter((e) => e.def)
    .sort((a, b) => b.count - a.count);
  const topPositive = ranked.filter((e) => e.def!.sentiment === 'POSITIVE').slice(0, 5)
    .map((e) => ({ tag: e.tag, label: e.def!.label, count: e.count }));
  const topNegative = ranked.filter((e) => e.def!.sentiment === 'NEGATIVE').slice(0, 5)
    .map((e) => ({ tag: e.tag, label: e.def!.label, count: e.count }));
  return { topPositive, topNegative };
}

function coachingFor(role: Role, standing: string, topNegative: Array<{ tag: string; label: string }>) {
  return standing === 'ATTENTION' || standing === 'AT_RISK'
    ? topNegative.slice(0, 3)
        .map((t) => ({ tag: t.tag, label: t.label, line: COACHING[role][t.tag] }))
        .filter((c): c is { tag: string; label: string; line: string } => !!c.line)
    : [];
}

/** The one Standing computation — every role dashboard reads this. */
export async function actorStandingView(prisma: PrismaClient, role: Role, subjectId: string): Promise<StandingView> {
  if (role !== 'VENDOR') return personStandingView(prisma, role, subjectId);
  // [E17 / danger #23] The stat row is tenant-composite: hardcoding
  // 'swift-default' silently degraded every non-default-tenant actor to the
  // new-actor fallback surface. Authenticated dashboards carry their tenant
  // in request context; the default remains only as the legacy fallback.
  const tenantId = getTenantId() ?? 'swift-default';
  const stat = await prisma.actorRatingStat.findUnique({
    where: { tenantId_subjectRole_subjectId: { tenantId, subjectRole: role, subjectId } },
  });
  const surface = stat ? surfaceOf(stat, role) : NEW_ACTOR_SURFACE;
  const boundary = stat?.actorVisibleAt ?? startOfUtcDay(new Date());

  const rows = await prisma.rating.findMany({
    where: {
      type: { in: TYPES_FOR_ROLE[role] as never },
      state: 'ACTIVE',
      createdAt: { lt: boundary },
      ...(role === 'VENDOR' ? { vendorId: subjectId } : { rateeId: subjectId }),
    },
    orderBy: { createdAt: 'desc' },
    select: { score: true, tags: true, createdAt: true },
  });

  const foldedCount = rows.length;
  const foldedAverage = foldedCount ? Math.round((rows.reduce((s, r) => s + r.score, 0) / foldedCount) * 100) / 100 : null;

  // 13 whole weeks back from the boundary — bucket i covers [start, start+7d).
  const trend: StandingView['trend'] = [];
  const windowStart = boundary.getTime() - 13 * WEEK_MS;
  for (let i = 0; i < 13; i++) {
    const start = windowStart + i * WEEK_MS;
    const inBucket = rows.filter((r) => r.createdAt.getTime() >= start && r.createdAt.getTime() < start + WEEK_MS);
    trend.push({
      weekStart: new Date(start).toISOString().slice(0, 10),
      average: inBucket.length ? Math.round((inBucket.reduce((s, r) => s + r.score, 0) / inBucket.length) * 100) / 100 : null,
      count: inBucket.length,
    });
  }

  // Folded tag counts, labelled + split by the seeded taxonomy.
  const { topPositive, topNegative } = await rankedTags(prisma, role, rows);

  const standing = stat?.standing ?? 'NEW';
  const coaching = coachingFor(role, standing, topNegative);

  return {
    standing,
    ...surface,
    foldedAt: boundary.toISOString(),
    folded: { count: foldedCount, average: foldedAverage },
    trend,
    topPositive,
    topNegative,
    coaching,
  };
}

/** The daily fold (RAT-G): stamp every stat row's actorVisibleAt so tag counts
 *  and trends advance once a day, in one batch, for everyone. */
export async function runActorFold(prisma: PrismaClient): Promise<number> {
  const res = await prisma.actorRatingStat.updateMany({ data: { actorVisibleAt: new Date() } });
  return res.count;
}
