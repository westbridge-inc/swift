/** The pilot market's IANA zone, declared ONCE for every app. The phone and
 *  the web format every appointment time through it; the API's own literal
 *  (apps/api/src/modules/prep/prep-time.ts) is pinned to this one at compile
 *  time. Appointment instants on the wire and in the database are TRUE UTC
 *  instants; this zone is only ever a formatting/resolution input. */
export const GUYANA_TZ = 'America/Guyana';
