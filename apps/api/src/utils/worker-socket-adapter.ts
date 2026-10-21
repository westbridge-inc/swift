import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { withTimeout } from './async-lifecycle';
import { usesSocketRedisAdapter } from './runtime-mode';

/**
 * The worker process's side of the Socket.IO Redis adapter. Its io has no
 * listener: every emit a job makes (order:new when a held order is released,
 * dispatch offers, order status) must travel through Redis to the API process
 * that holds the sockets. Without the adapter those emits reached nobody.
 *
 * Runs whenever usesSocketRedisAdapter() says so (production, loadtest/staging,
 * development). The two connections are pushed into `connections` BEFORE the
 * startup ping, so the caller's cleanup closes them even when startup fails.
 * Returns whether the adapter was attached.
 */
export async function attachWorkerSocketAdapter(
  { io, redis, log, startupTimeoutMs }: {
    io: Server;
    redis: Redis;
    log: { error: (obj: object, msg: string) => void };
    startupTimeoutMs: number;
  },
  connections: Redis[],
): Promise<boolean> {
  if (!usesSocketRedisAdapter()) return false;
  const { createAdapter } = await import('@socket.io/redis-adapter');
  const pub = redis.duplicate();
  const sub = redis.duplicate();
  connections.push(pub, sub);
  for (const [kind, connection] of [['publish', pub], ['subscribe', sub]] as const) {
    connection.on('error', (err) => log.error({ err, kind }, 'Socket.IO Redis adapter error'));
  }
  await withTimeout(
    Promise.all([pub.ping(), sub.ping()]),
    startupTimeoutMs,
    'Socket.IO Redis adapter startup',
  );
  io.adapter(createAdapter(pub, sub));
  return true;
}
