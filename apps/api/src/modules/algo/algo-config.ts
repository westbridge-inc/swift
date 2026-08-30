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
  /**
   * How many live delivery legs one RIDER may hold at once. The concurrency
   * seam (dispatch/concurrency-policy.ts) resolves through this; the DRIVER
   * pool never reads it — a taxi carries one passenger's custody at a time as
   * law, not configuration. Default 1 = the platform's historical behaviour;
   * the founder-directed launch value is seeded as a row (2026-08-29:
   * "riders and delivery guys can accept multiple orders, only taxis can't").
   * Clamped 1..3 at the reader; 1 is the kill switch, no deploy needed.
   */
  'stacking.riderCapacity': 1,
  /**
   * [ALG-26] The soft threshold of a rider's cash float, as a fraction of
   * their limit, at which the cockpit starts nudging them to finish
   * deliveries before taking more cash work. The hard threshold is 1.0 by
   * construction (FloatService.commit refuses past the limit). Clamped
   * 0.1..1.0 at the reader; 1.0 turns the nudge off.
   */
  'float.softPct': 0.7,
  /**
   * [ALG-15] The speed between two consecutive fixes above which a position
   * is flagged for review — a teleport. 140 km/h: nothing on a Guyanese road
   * moves faster honestly. Clamped 60..300 at the reader.
   */
  'gps.maxPlausibleKmh': 140,
  /** [ALG-15] Kill switch. Off ⇒ no assessment, no trace, no rows — today's behaviour. */
  'ALG-15.enabled': true,
  /**
   * [ALG-30] Accept-then-handback inside this many seconds is the
   * cherry-picking signal (Kerb §5.3 CHERRY_WINDOW_S). Advisory: a row for
   * the reviewer, never a penalty. Clamped 10..3600 at the reader.
   */
  'gaming.cherryWindowS': 90,
  /** [ALG-30] Kill switch. Off ⇒ no assessment, no rows — today's behaviour. */
  'ALG-30.enabled': true,
  /**
   * [ALG-34 / ALG-INV-14] Hours a staged MMG pay link change waits, with the
   * old link still live and the owner told, before the cool-off job applies
   * it. Clamped 1..72 at the reader. The step-up that precedes it has no
   * dial: a switch on a security invariant is itself the attack surface.
   */
  'money.linkCooloffHours': 24,
  /**
   * [ALG-38] The generic velocity engine's per-action limits, for the
   * surfaces no dedicated limiter thought about. Each action: how many in
   * how many seconds per ACTOR, and per identity CLUSTER (the one that
   * matters — per-account limits are defeated by making accounts). A stored
   * override merges over these per action. Safety actions are never here
   * and never limited.
   */
  'velocity.limits': {
    'promo.validate': { max: 10, perSeconds: 600, clusterMax: 30 },
    'return.request': { max: 5, perSeconds: 86_400, clusterMax: 10 },
  } as Record<string, { max: number; perSeconds: number; clusterMax?: number }>,
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
