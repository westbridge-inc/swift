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

export const dispatchExhaustLockKey = (orderId: string, version?: number | null): string =>
  `dispatch:exhaust-lock:${orderId}${deliveryGenerationSuffix(version)}`;

export const dispatchGenerationInitKey = (orderId: string, version: number): string =>
  `dispatch:generation-init:${orderId}:fv${version}`;
