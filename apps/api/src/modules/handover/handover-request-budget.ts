import type Redis from 'ioredis';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';

const REQUEST_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return count
`;

/** At most this many handover requests per order per minute, behind authorization. */
export const HANDOVER_REQUESTS_PER_MINUTE = 30;

/**
 * Secondary request ceiling, after ownership authorization. The durable
 * five-comparison budget (checked under the order lock) remains authoritative
 * and never resets here.
 *
 * [coordinator ruling 11 Oct] It fails OPEN: if Redis cannot count, the request
 * goes on to the durable budget, which still refuses a sixth wrong guess. A
 * Redis outage must never stop every pickup and delivery completion.
 */
export async function assertHandoverRequestBudget(redis: Pick<Redis, 'eval'>, orderId: string): Promise<void> {
  let count: number;
  try {
    count = Number(await redis.eval(REQUEST_WINDOW, 1, `handover:requests:${orderId}`));
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid request counter');
  } catch (err) {
    log().warn({ orderId, err: err instanceof Error ? err.message : String(err) }, 'handover:request-budget-unavailable');
    return;
  }
  if (count > HANDOVER_REQUESTS_PER_MINUTE) {
    throw new AppError(429, 'HANDOVER_RATE_LIMITED', 'Too many handover requests for this order. Wait a minute before trying again.');
  }
}
