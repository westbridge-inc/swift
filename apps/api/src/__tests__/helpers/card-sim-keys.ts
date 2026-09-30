import type Redis from 'ioredis';

// [PT-1 · AX297 F3] The card simulator keeps its sessions, captures and
// refunds in Redis, and test runs share a Redis database. A run gives its
// simulators their own namespace and, when it is done, deletes exactly the
// keys under it. Never `cardsim:*`: that is every other run's sessions and
// capture records too (and a dev server's).

/** This run's simulator namespace. */
export function runKeyPrefix(run: string): string {
  if (!/^[A-Za-z0-9]{4,40}$/.test(run)) throw new Error(`not a run id: ${JSON.stringify(run)}`);
  return `cardsim:t-${run}:`;
}

/** Delete the keys under one run's namespace (SCAN, never KEYS), and only those. */
export async function deleteRunKeys(redis: Redis, prefix: string): Promise<number> {
  // Only a run namespace from runKeyPrefix: the shape leaves no glob character
  // and cannot be the shared `cardsim:` itself.
  if (!/^cardsim:t-[A-Za-z0-9]{4,40}:$/.test(prefix)) throw new Error(`refusing to delete outside a run namespace: ${JSON.stringify(prefix)}`);
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    const mine = keys.filter((k) => k.startsWith(prefix));
    if (mine.length > 0) deleted += await redis.del(...mine);
  } while (cursor !== '0');
  return deleted;
}
