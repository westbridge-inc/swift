import { createHash } from 'node:crypto';

/**
 * Redis search memory is scoped to a delivery-custody generation after the
 * first ownership switch. Generation zero deliberately keeps the historical
 * key format so an in-flight pre-deploy cascade survives the rollout.
 *
 * Order.fulfillmentModeVersion is monotonic: once a delivery has switched,
 * an older worker can therefore mutate only its own suffix. Taxi searches do
 * not have delivery custody generations and pass no version.
 */
export const deliveryGenerationSuffix = (version?: number | null): string =>
  version != null && Number.isSafeInteger(version) && version > 0 ? `:fv${version}` : '';

export const dispatchDeclinedKey = (orderId: string, version?: number | null): string =>
  `dispatch:declined:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchRoundKey = (orderId: string, version?: number | null): string =>
  `dispatch:round:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchExhaustKey = (orderId: string, version?: number | null): string =>
  `dispatch:exhausts:${orderId}${deliveryGenerationSuffix(version)}`;

/** [E36] The replay identity of one queued dispatch run: a short hash of the
 *  BullMQ job id. A redelivery (the worker died, the job's lock lapsed)
 *  replays the SAME job id, so it gets the same tag; every genuine cycle is a
 *  different job with a different tag. Hashed so it is colon-free (BullMQ
 *  refuses a custom job id containing ':' unless it has exactly three parts)
 *  and so a re-arm chain keyed by its parent's tag never grows in length. */
export const dispatchReplayTag = (jobId: string): string =>
  createHash('sha256').update(jobId).digest('hex').slice(0, 20);

/** [E36] Marks that the run with this replay tag already committed its
 *  exhaustion attempt-count increment for this search, so a redelivery reuses
 *  that count instead of INCRing again. Lives for the terminal window
 *  (EXHAUST_TERMINAL_TTL_SECONDS), like the counter itself. */
export const exhaustJobKey = (orderId: string, version: number | null | undefined, replayTag: string): string =>
  `dispatch:exhaust-job:${orderId}${deliveryGenerationSuffix(version)}:${replayTag}`;

/** [E36] The re-arm a run schedules, keyed by that run's replay tag: a
 *  redelivered run re-adds the SAME job id and BullMQ keeps the first. Keyed
 *  by the parent run, never by the attempt count: the counter restarts at 1
 *  after a manual retry, and an id reused from a retained completed job would
 *  make BullMQ silently drop a legitimate re-sweep. */
export const redispatchJobId = (orderId: string, replayTag: string): string =>
  `redispatch-${orderId}-${replayTag}`;

export const dispatchExhaustLockKey = (orderId: string, version?: number | null): string =>
  `dispatch:exhaust-lock:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchGenerationInitKey = (orderId: string, version: number): string =>
  `dispatch:generation-init:${orderId}:fv${version}`;
