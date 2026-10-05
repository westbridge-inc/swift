// ---------------------------------------------------------------------------
// [money] What an OSRM answer may be priced from. A distance or a duration
// that OSRM PRESENTS must be a finite, non-negative number. Anything else it
// sent (Infinity from JSON 1e309, NaN, a negative, a string, a boolean) is
// not missing but wrong, and a fare is never priced from it. A duration may be
// ABSENT (undefined or null): the caller then applies its own speed model, as
// it always has.
//
// One law for every OSRM route answer. The single-leg route (routeKm) reads
// it here. The multi-stop route (routeLegs, taxi multi-stop 2/8) carries the
// same rule as private helpers in maps-provider.ts; a follow-up moves it onto
// this module.
// ---------------------------------------------------------------------------

/** A measure OSRM may give: a finite, non-negative number (metres, seconds). */
export function isOsrmMeasure(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** A duration is either absent (undefined or null) or a real measure. */
export function isOsrmDurationOrAbsent(v: unknown): boolean {
  return v === undefined || v === null || isOsrmMeasure(v);
}
