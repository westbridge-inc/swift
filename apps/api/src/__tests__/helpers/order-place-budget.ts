import type Redis from 'ioredis';
import { ORDER_PLACE_ACTION } from '../../modules/integrity/velocity';

/**
 * A suite that walks many orders on one customer to prove something else starts each case with a fresh hourly budget.
 * The limit itself is proved in order-place-limit.test.ts.
 */
export async function freshOrderPlaceBudget(redis: Redis): Promise<void> {
  const keys = await redis.keys(`vel:${ORDER_PLACE_ACTION}:*`);
  if (keys.length) await redis.del(...keys);
}
