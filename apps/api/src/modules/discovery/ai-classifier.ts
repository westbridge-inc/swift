import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Stage B — the AI classifier (spec Part 4). For items Stage A couldn't place
// (no suggestions, no tags), a budgeted Claude pass proposes taxonomy slugs.
// Discipline, exactly:
//   · its own flag (CATEGORIZER_AI_ENABLED; off or no key = silent no-op —
//     Stage-A-only is the honest floor, nobody sees a degraded state)
//   · a daily item budget; exhausted means the queue WAITS until tomorrow
//   · every slug validates against the ACTIVE taxonomy — hallucinations are
//     dropped and counted, never stored
//   · results land as suggestions (stage=AI), same table, same UI, same
//     sticky-choice law
//   · one audit row per classified item (the agent infra's audit table).
// ---------------------------------------------------------------------------

export interface CategoryClassifier {
  enabled: boolean;
  classifyCategories(
    items: Array<{ id: string; name: string; description?: string | null }>,
    taxonomy: Array<{ slug: string; name: string; kind: string }>,
  ): Promise<Record<string, Array<{ slug: string; confidence: number }>> | null>;
}

export const CAT_AI_DAILY_ITEMS = Math.max(1, Number(process.env['CAT_AI_DAILY_ITEMS'] ?? 500));
const BATCH = 10;

export function categorizerEnabled(classifier: CategoryClassifier): boolean {
  if (process.env['CATEGORIZER_AI_ENABLED'] === '0') return false;
  return classifier.enabled;
}

let hallucinatedTotal = 0;
/** Observability: cat_ai_hallucinated_total. */
export function catAiHallucinatedTotal(): number {
  return hallucinatedTotal;
}

/**
 * One budgeted batch run. Returns counts; safe to run any time — re-runs
 * skip already-suggested/tagged items by construction of the candidate query.
 */
export async function runAiClassifierBatch(
  prisma: PrismaClient,
  classifier: CategoryClassifier,
  opts: { tenantId?: string; limit?: number; vendorId?: string } = {},
): Promise<{ scanned: number; suggested: number; dropped: number; budgetLeft: number }> {
  const tenantId = opts.tenantId ?? 'swift-default';
  if (!categorizerEnabled(classifier)) return { scanned: 0, suggested: 0, dropped: 0, budgetLeft: 0 };

  // Daily budget: audit rows are the persistent counter (exhausted = wait).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const usedToday = await prisma.agentAuditEvent.count({
    where: { job: 'categorizer', at: { gte: dayStart } },
  });
  const budgetLeft = Math.max(0, CAT_AI_DAILY_ITEMS - usedToday);
  if (budgetLeft === 0) return { scanned: 0, suggested: 0, dropped: 0, budgetLeft: 0 };

  const limit = Math.min(opts.limit ?? BATCH * 5, budgetLeft);

  // Candidates: live items with NO suggestion rows and NO tags — exactly the
  // ground Stage A couldn't place and no human has touched (law C by query).
  // Raw SQL: Prisma can't express NOT EXISTS across relation-less tables.
  const raw = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; description: string | null }>>(
    `SELECT i.id, i.name, i.description
     FROM "items" i
     JOIN "vendors" v ON v.id = i."vendorId" AND v.status = 'ACTIVE' AND v."tenantId" = $1
     WHERE i."isAvailable" = true
       AND ($3::text IS NULL OR i."vendorId" = $3)
       AND NOT EXISTS (SELECT 1 FROM "discovery_category_suggestions" s WHERE s."itemId" = i.id)
       AND NOT EXISTS (SELECT 1 FROM "item_discovery_categories" t WHERE t."itemId" = i.id)
     ORDER BY i."createdAt" ASC
     LIMIT $2`,
    tenantId,
    limit,
    opts.vendorId ?? null,
  );
  if (raw.length === 0) return { scanned: 0, suggested: 0, dropped: 0, budgetLeft };

  const taxonomy = await prisma.discoveryCategory.findMany({
    where: { tenantId, status: 'ACTIVE' },
    select: { id: true, slug: true, name: true, kind: true },
  });
  const bySlug = new Map(taxonomy.map((t) => [t.slug, t]));

  let suggested = 0;
  let dropped = 0;
  let scanned = 0;
  for (let i = 0; i < raw.length; i += BATCH) {
    const batch = raw.slice(i, i + BATCH);
    const result = await classifier.classifyCategories(batch, taxonomy);
    if (!result) break; // model down/slow — the queue waits, silently
    for (const item of batch) {
      scanned += 1;
      const proposals = result[item.id] ?? [];
      const kept: string[] = [];
      for (const p of proposals) {
        const category = bySlug.get(p.slug);
        if (!category) {
          dropped += 1;
          hallucinatedTotal += 1;
          continue;
        }
        await prisma.discoveryCategorySuggestion.upsert({
          where: { itemId_categoryId: { itemId: item.id, categoryId: category.id } },
          create: { tenantId, itemId: item.id, categoryId: category.id, confidence: p.confidence, stage: 'AI', status: 'PENDING' },
          update: {}, // law C: never overwrite an existing row from here
        });
        kept.push(`${p.slug}:${p.confidence}`);
        suggested += 1;
      }
      await prisma.agentAuditEvent.create({
        data: {
          job: 'categorizer',
          subjectId: item.id,
          action: 'classify',
          input: { name: item.name },
          outcome: 'suggested',
          reasoning: kept.join(', ') || 'no placement',
        },
      });
    }
  }
  return { scanned, suggested, dropped, budgetLeft: budgetLeft - scanned };
}
