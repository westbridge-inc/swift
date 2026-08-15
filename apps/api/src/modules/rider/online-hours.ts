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
  const sinceKey = `rider:online_since:${riderId}`;
  const todayKey = `rider:online_ms:${riderId}:${startOfDayGY().toISOString().slice(0, 10)}`;
  // One Redis command is the idempotency boundary. The former GET → INCRBY →
  // EXPIRE → DEL sequence could crash after INCRBY and then count the same
  // shift twice when a durable revocation retry replayed it.
  await redis.eval(
    `
      local onlineSince = redis.call('GET', KEYS[1])
      if not onlineSince then return 0 end
      local sessionMs = tonumber(ARGV[1]) - tonumber(onlineSince)
      if sessionMs < 0 then sessionMs = 0 end
      redis.call('INCRBY', KEYS[2], sessionMs)
      redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
      redis.call('DEL', KEYS[1])
      return sessionMs
    `,
    2,
    sinceKey,
    todayKey,
    now,
    ONLINE_MS_TTL_SECONDS,
  );
}
