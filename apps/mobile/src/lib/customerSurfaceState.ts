import { isAxiosError } from 'axios';

export const PUBLIC_MARKET_DEPTH_KEY = ['market', 'depth'] as const;

export type PublicMarketDepth = Readonly<{
  visible: boolean;
  items: number;
  vendors: number;
}>;

export type CustomerHomeKey = readonly [
  'customer',
  'home',
  number,
  number | null,
  number | null,
];

export function customerHomeKey(
  generation: number,
  lat?: number,
  lng?: number,
): CustomerHomeKey {
  const located =
    typeof lat === 'number'
    && Number.isFinite(lat)
    && typeof lng === 'number'
    && Number.isFinite(lng);

  return [
    'customer',
    'home',
    generation,
    located ? lat : null,
    located ? lng : null,
  ];
}

export function homePlaceholderForCoordinateChange<T>(
  previousData: T | undefined,
  previousKey: readonly unknown[] | undefined,
  nextKey: CustomerHomeKey,
): T | undefined {
  if (
    previousData === undefined
    || !previousKey
    || previousKey.length !== 5
    || previousKey[0] !== 'customer'
    || previousKey[1] !== 'home'
  ) {
    return undefined;
  }

  const samePrincipal = previousKey[2] === nextKey[2];
  const wasUnlocated = previousKey[3] === null && previousKey[4] === null;
  const isNowLocated = nextKey[3] !== null && nextKey[4] !== null;

  return samePrincipal && wasUnlocated && isNowLocated
    ? previousData
    : undefined;
}

export function retryTransientReadOnce(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= 1 || !isAxiosError(error)) return false;

  const status = error.response?.status;
  return (
    status === undefined
    || status === 408
    || status === 429
    || (status >= 500 && status <= 599)
  );
}

export type HomeSurfaceState =
  | 'initial-loading'
  | 'initial-paused'
  | 'initial-error'
  | 'stale-error'
  | 'stale-paused'
  | 'stale-location'
  | 'refreshing'
  | 'ready';

export function classifyHomeSurface(input: {
  hasData: boolean;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isFetching: boolean;
  isPlaceholderData: boolean;
}): HomeSurfaceState {
  if (input.hasData) {
    if (input.status === 'error') return 'stale-error';
    if (input.fetchStatus === 'paused') return 'stale-paused';
    if (input.isPlaceholderData) return 'stale-location';
    if (input.isFetching) return 'refreshing';
    return 'ready';
  }

  if (input.fetchStatus === 'paused') return 'initial-paused';
  if (input.status === 'error') return 'initial-error';
  return 'initial-loading';
}

export function decodePublicMarketDepth(
  input: unknown,
): PublicMarketDepth | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const value = input as Record<string, unknown>;
  if (
    typeof value['visible'] !== 'boolean'
    || typeof value['items'] !== 'number'
    || !Number.isSafeInteger(value['items'])
    || value['items'] < 0
    || typeof value['vendors'] !== 'number'
    || !Number.isSafeInteger(value['vendors'])
    || value['vendors'] < 0
  ) {
    return null;
  }

  // Only these public aggregate fields may survive an account boundary.
  return {
    visible: value['visible'],
    items: value['items'],
    vendors: value['vendors'],
  };
}

export type MarketDepthState =
  | 'unknown'
  | 'unavailable'
  | 'hidden'
  | 'visible';

export function classifyMarketDepth(
  data: PublicMarketDepth | undefined,
  isError: boolean,
): MarketDepthState {
  // A prior confirmed result remains authoritative during a failed refresh.
  if (data) return data.visible ? 'visible' : 'hidden';
  return isError ? 'unavailable' : 'unknown';
}

/** Keep the route stable through startup and transient failures. Only a
 * confirmed server decision may remove Market from the navigator. */
export function shouldMountMarketTab(
  data: PublicMarketDepth | undefined,
  isError: boolean,
): boolean {
  return classifyMarketDepth(data, isError) !== 'hidden';
}
