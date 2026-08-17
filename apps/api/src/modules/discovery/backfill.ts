import type { PrismaClient } from '@prisma/client';
import { DiscoveryService } from './discovery.service';
import { reconcileAllDerived } from './derivation';
import { runAiClassifierBatch, type CategoryClassifier } from './ai-classifier';
import { requireDiscoveryTenantId } from './tenant-boundary';

// ---------------------------------------------------------------------------
// The backfill movement (#17 Part 4, CAT-I): run once per tenant behind the
// flag — Stage A across every live item, Stage B for what A couldn't place
// (under the daily budget; the un-placed remainder simply waits for the
// hourly job on later days), Stage C derivation, then ONE notification per
// vendor with pending suggestions. Idempotent by construction (upserts +
// law-C frozen ground): a re-run scans again but writes nothing new and
// never re-notifies. Keyset iteration — no OFFSET on a growing table (#22).
// ---------------------------------------------------------------------------

export interface BackfillReport {
  itemsScanned: number;
  matcherSuggestionsWritten: number;
  aiScanned: number;
  aiSuggested: number;
  aiBudgetLeft: number;
  derivedAdded: number;
  derivedRemoved: number;
  vendorsNotified: number;
}

const LEGACY_NOTIFIED_MARKER = 'categories.backfill.notified';
export const categoryBackfillNotifiedMarker = (tenantId: string) => `${LEGACY_NOTIFIED_MARKER}:${tenantId}`;

export async function runCategoryBackfill(
  prisma: PrismaClient,
  classifier: CategoryClassifier,
  opts: {
    tenantId: string;
    /** Send the review notification to vendors with pending suggestions. */
    notify?: (userId: string) => Promise<void>;
    batchSize?: number;
    /** Injectable accounting clock; production defaults to the current UTC day. */
    now?: Date;
  },
): Promise<BackfillReport> {
  const tenantId = requireDiscoveryTenantId(opts.tenantId);
  const discovery = new DiscoveryService(prisma);
  const batchSize = opts.batchSize ?? 200;

  // ---- Stage A: keyset walk over every live item of live vendors ----------
  let itemsScanned = 0;
  let matcherSuggestionsWritten = 0;
  let cursor: string | null = null;
  for (;;) {
    const items: Array<{ id: string; name: string; description: string | null }> = await prisma.item.findMany({
      where: {
        isAvailable: true,
        vendor: { status: 'ACTIVE', tenantId },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, name: true, description: true },
    });
    if (items.length === 0) break;
    for (const item of items) {
      matcherSuggestionsWritten += await discovery.runMatcherForItem(item, tenantId);
      itemsScanned += 1;
    }
    cursor = items[items.length - 1]!.id;
  }

  // ---- Stage B: the AI remainder, strictly under the daily budget ---------
  let aiScanned = 0;
  let aiSuggested = 0;
  let aiBudgetLeft = 0;
  for (;;) {
    const r = await runAiClassifierBatch(prisma, classifier, { tenantId, limit: 50, now: opts.now });
    aiScanned += r.scanned;
    aiSuggested += r.suggested;
    aiBudgetLeft = r.budgetLeft;
    if (r.scanned === 0) break; // no candidates left, budget spent, or model down
  }

  // ---- Stage C: derivation across the catalog -----------------------------
  const derived = await reconcileAllDerived(prisma, tenantId);

  // ---- Notify: one message per vendor with PENDING suggestions, ONCE ------
  let vendorsNotified = 0;
  if (opts.notify) {
    const pending = await prisma.discoveryCategorySuggestion.findMany({
      where: { tenantId, status: 'PENDING' },
      select: { itemId: true },
      distinct: ['itemId'],
    });
    const items = pending.length
      ? await prisma.item.findMany({
          where: { id: { in: pending.map((p) => p.itemId) }, vendor: { tenantId } },
          select: { vendorId: true },
          distinct: ['vendorId'],
        })
      : [];
    const markerKey = categoryBackfillNotifiedMarker(tenantId);
    const marker = await prisma.platformConfig.findUnique({ where: { key: markerKey } });
    // Rolling compatibility: the original marker mixed every tenant in one
    // vendor-id array. Import it once when a tenant marker is born, but never
    // mutate/delete it; existing vendors therefore are not re-notified.
    const legacy = marker
      ? null
      : await prisma.platformConfig.findUnique({ where: { key: LEGACY_NOTIFIED_MARKER } });
    const prior = marker?.value ?? legacy?.value;
    const already = new Set<string>(Array.isArray(prior) ? (prior as string[]) : []);

    for (const { vendorId } of items) {
      if (already.has(vendorId)) continue;
      const vendor = await prisma.vendor.findFirst({
        where: { id: vendorId, tenantId, owner: { user: { tenantId } } },
        select: { owner: { select: { userId: true } } },
      });
      if (!vendor) continue;
      await opts.notify(vendor.owner.userId).catch(() => undefined);
      already.add(vendorId);
      vendorsNotified += 1;
    }
    await prisma.platformConfig.upsert({
      where: { key: markerKey },
      create: { key: markerKey, value: [...already] },
      update: { value: [...already] },
    });
  }

  return {
    itemsScanned,
    matcherSuggestionsWritten,
    aiScanned,
    aiSuggested,
    aiBudgetLeft,
    derivedAdded: derived.added,
    derivedRemoved: derived.removed,
    vendorsNotified,
  };
}
