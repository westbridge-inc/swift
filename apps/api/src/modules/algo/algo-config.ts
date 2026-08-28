import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [ALGO Band 0.2] READING A TUNABLE.
//
// The platform's algorithm dials are scattered across two dozen files as bare
// `const`s. That is fine until someone asks "what was the per-km rate when this
// order was priced?" — and the only answer is "whatever the constant said when
// that commit was deployed", which nobody can reconstruct.
//
// This is the read half. It is deliberately boring:
//
//   · EVERY KEY'S DEFAULT LIVES IN CODE, beside the algorithm that reads it.
//     A key with no row resolves to that default, so an empty table behaves
//     exactly as today and moving a constant in here is a no-behaviour-change
//     edit that can be proven so.
//
//   · ROWS ARE IMMUTABLE VERSIONS. The value in force is the HIGHEST version
//     for a key. Nothing is edited, so a decision stamped with version 3 can
//     still be read against the row that produced it after version 4 lands.
//
//   · IT NEVER THROWS INTO AN ALGORITHM. A database hiccup while pricing an
//     order must not fail the order; a failed read logs and falls back to the
//     code default, which is the value the platform ran on yesterday. Degraded
//     config makes the system behave as it did before the dial existed, never
//     as if the dial were zero [L6].
//
// The write path is deliberately NOT here. `founderGated` keys exist precisely
// because some values are not engineering's to change, and a setter with no
// authorization story would be the wrong thing to reach for.
// ---------------------------------------------------------------------------

/** What a resolved tunable is: the value, and where it came from. */
export interface ResolvedConfig<T> {
  value: T;
  /** 0 means "no row — this is the code default". Stamp it onto decisions. */
  version: number;
  source: 'default' | 'config';
}

/**
 * Every tunable this store knows about, with the value the platform runs on
 * TODAY. These are not suggestions: an empty table must reproduce current
 * behaviour exactly, so each entry is copied from the constant it replaces and
 * the constant becomes a re-export of this.
 *
 * Adding a key here changes nothing by itself. It becomes live when the
 * algorithm that owns the constant reads it through `algoConfig()`.
 */
export const ALGO_DEFAULTS = {
  /**
   * Batching shadow scan: how many candidate pairs one tick may evaluate.
   * Was `EVAL_CAP` in `batching/shadow-scan.ts`. Chosen first because the
   * shadow scan writes evidence and changes NOTHING a customer or a rider can
   * see, so a mistake here cannot reach a person.
   */
  'batching.evalCap': 200,
  /**
   * Batching shadow scan: one row per candidate pair per this many minutes.
   * Was `PAIR_DEDUP_MIN` in the same file — a tunable of exactly the same class
   * that the algorithm document's seed list omits.
   */
  'batching.pairDedupMinutes': 30,
} as const;

export type AlgoConfigKey = keyof typeof ALGO_DEFAULTS;

const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: unknown; version: number; source: 'default' | 'config'; expiresAt: number };
const cache = new Map<string, CacheEntry>();

const cacheKey = (tenantId: string, key: string) => `${tenantId}:${key}`;

/** Drop cached values. Called by whatever writes a new version, and by tests. */
export function invalidateAlgoConfig(tenantId?: string, key?: string): void {
  if (!tenantId) { cache.clear(); return; }
  if (!key) {
    for (const k of [...cache.keys()]) if (k.startsWith(`${tenantId}:`)) cache.delete(k);
    return;
  }
  cache.delete(cacheKey(tenantId, key));
}

/**
 * The value in force for `key`, or the code default.
 *
 * `tenantId` is explicit rather than read from async context: this is called
 * from sweeps and workers that have no request bound to them, and a tunable
 * silently resolving to the wrong operator's value is worse than one that
 * cannot be read at all.
 */
export async function algoConfig<K extends AlgoConfigKey>(
  prisma: PrismaClient,
  key: K,
  tenantId = 'swift-default',
): Promise<ResolvedConfig<(typeof ALGO_DEFAULTS)[K]>> {
  const fallback = ALGO_DEFAULTS[key];
  const ck = cacheKey(tenantId, key);
  const hit = cache.get(ck);
  if (hit && hit.expiresAt > Date.now()) {
    return { value: hit.value as (typeof ALGO_DEFAULTS)[K], version: hit.version, source: hit.source };
  }

  let resolved: ResolvedConfig<(typeof ALGO_DEFAULTS)[K]> = { value: fallback, version: 0, source: 'default' };
  try {
    const row = await prisma.algoConfig.findFirst({
      where: { tenantId, key },
      orderBy: { version: 'desc' },
      select: { value: true, version: true },
    });
    // A row whose value is JSON `null` is not a configured value — it is a row
    // that says nothing. Treat it as absent rather than handing an algorithm a
    // null where it expects a number.
    if (row && row.value !== null) {
      resolved = { value: row.value as (typeof ALGO_DEFAULTS)[K], version: row.version, source: 'config' };
    }
  } catch (err) {
    // Never throw into an algorithm. Yesterday's behaviour beats no behaviour.
    log().warn({ err, key, tenantId }, 'algo-config: read failed, using code default');
    return { value: fallback, version: 0, source: 'default' };
  }

  cache.set(ck, { value: resolved.value, version: resolved.version, source: resolved.source, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

/** The common case: the value alone, when the caller does not stamp a version. */
export async function algoValue<K extends AlgoConfigKey>(
  prisma: PrismaClient,
  key: K,
  tenantId = 'swift-default',
): Promise<(typeof ALGO_DEFAULTS)[K]> {
  return (await algoConfig(prisma, key, tenantId)).value;
}
