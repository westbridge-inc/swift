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

/** [E36] Per-job one-shot exhaustion token. A BullMQ redelivery replays the
 *  SAME job id, so recording which job already committed the attempt-count
 *  increment lets the exhaustion script reuse that count instead of INCRing
 *  again. A genuine next cycle is a different BullMQ job, hence a different
 *  token, so accumulation up to EXHAUST_CAP is preserved. The key lives only
 *  as long as the terminal window (EXHAUST_TERMINAL_TTL_SECONDS): a replay
 *  after that window is a legitimate fresh search. */
export const exhaustJobKey = (orderId: string, version?: number | null, jobToken?: string | null): string =>
  `dispatch:exhaust-job:${orderId}${deliveryGenerationSuffix(version)}:${jobToken ?? ''}`;

export const dispatchExhaustLockKey = (orderId: string, version?: number | null): string =>
  `dispatch:exhaust-lock:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchGenerationInitKey = (orderId: string, version: number): string =>
  `dispatch:generation-init:${orderId}:fv${version}`;
