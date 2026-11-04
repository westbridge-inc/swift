// ---------------------------------------------------------------------------
// [FIXES-4] How many server errors the API answered, hour by hour, in Redis:
// one counter per hour, shared by every API process, read by the worker's
// error-rate watch (modules/ops/error-rate-watch.ts). Light on purpose: the
// error handler writes it on its way out, and a count never carries a route,
// a person or a message.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
/** Longer than the 25 hour reach of the watch, so an hour is never read after it expired. */
export const HOURLY_TALLY_TTL_SECONDS = 26 * 3600;

export type ServerErrorTallyWriter = { incr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<unknown> };
export type ServerErrorTallyReader = { mget(keys: string[]): Promise<Array<string | null>> };

export const serverErrorHourKey = (ms: number) => `err5xx:hour:${Math.floor(ms / HOUR_MS)}`;

/** One more server error in this hour's counter. Every write renews the expiry, so a counter never outlives it. */
export async function tallyServerError(redis: ServerErrorTallyWriter, nowMs: number = Date.now()): Promise<void> {
  const key = serverErrorHourKey(nowMs);
  await redis.incr(key);
  await redis.expire(key, HOURLY_TALLY_TTL_SECONDS);
}

/** The counts of the last `hours` hours, this hour first. */
export async function serverErrorsByHour(redis: ServerErrorTallyReader, hours: number, nowMs: number): Promise<number[]> {
  const keys = Array.from({ length: hours }, (_, i) => serverErrorHourKey(nowMs - i * HOUR_MS));
  return (await redis.mget(keys)).map((value) => Number(value ?? 0));
}
