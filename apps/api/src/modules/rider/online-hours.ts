import type Redis from 'ioredis';
import { startOfDayGY } from '../../utils/time-gy';

// SWIFT-143: the rider online-hours ledger lives in Redis — `rider:online_since:<id>`
// marks an open session; `rider:online_ms:<id>:<day>` accumulates completed session
// time. The ONLY thing that closes a session is this helper. It MUST run wherever a
// rider goes offline — voluntarily OR forced (stale-GPS sweep, doc-expiry, etc.) —
// or `online_since` lingers and the stats endpoint counts a phantom open session
// forever, overcounting the rider's hours.

const ONLINE_MS_TTL_SECONDS = 172800; // 48h

/** Open a rider's online-hours session (on go-online). */
export async function startOnlineSession(redis: Redis, riderId: string, now = Date.now()): Promise<void> {
  await redis.set(`rider:online_since:${riderId}`, String(now));
}

/** Close a rider's online-hours session: fold the elapsed time into today's bucket
 *  and clear the open marker. No-op when no session is open, so it's safe to call
 *  unconditionally on any offline transition. */
export async function closeOnlineSession(redis: Redis, riderId: string, now = Date.now()): Promise<void> {
  const onlineSince = await redis.get(`rider:online_since:${riderId}`);
  if (!onlineSince) return;
  const sessionMs = now - parseInt(onlineSince, 10);
  const todayKey = `rider:online_ms:${riderId}:${startOfDayGY().toISOString().slice(0, 10)}`;
  await redis.incrby(todayKey, sessionMs);
  await redis.expire(todayKey, ONLINE_MS_TTL_SECONDS);
  await redis.del(`rider:online_since:${riderId}`);
}
