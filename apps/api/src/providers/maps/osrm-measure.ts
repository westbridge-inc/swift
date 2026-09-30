// ---------------------------------------------------------------------------
// [money] What an OSRM answer may be priced from. A distance or a duration
// that OSRM PRESENTS must be a finite, non-negative number. Anything else it
// sent (Infinity from JSON 1e309, NaN, a negative, a string, a boolean) is
// not missing but wrong, and a fare is never priced from it. A duration may be
// ABSENT (undefined or null): the caller then applies its own speed model, as
// it always has.
//
// One law for every OSRM route answer. The single-leg route (routeKm) reads
// it here; the multi-stop route (taxi multi-stop, PR 2 of 8, unmerged) carries
// the same rule in maps-provider.ts, and moves onto this module once both
// have merged.
// ---------------------------------------------------------------------------

/** A measure OSRM may give: a finite, non-negative number (metres, seconds). */
export function isOsrmMeasure(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** A duration is either absent (undefined or null) or a real measure. */
export function isOsrmDurationOrAbsent(v: unknown): boolean {
  return v === undefined || v === null || isOsrmMeasure(v);
}
