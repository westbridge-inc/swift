import { MMKV } from 'react-native-mmkv';
import {
  applyVerdicts,
  pruneQueue,
  restoreQueue,
  retireQueueScope,
  takeBatchForScope,
  type AdEventVerdict,
  type AdEventScope,
  type QueuedAdEvent,
} from './adsCore';

const QUEUE_KEY = 'events';

// Queue state is deliberately isolated from auth/API imports. This lets the
// auth boundary retire A synchronously before B becomes usable without a
// module cycle. Only opaque scope IDs enter this plain local store.
let store: MMKV | null = null;
try {
  store = new MMKV({ id: 'swift-ads' });
} catch {
  store = null;
}

let queue: QueuedAdEvent[] = (() => {
  try {
    const raw = store?.getString(QUEUE_KEY);
    return raw ? restoreQueue(JSON.parse(raw) as unknown, Date.now()) : [];
  } catch {
    return [];
  }
})();

function persistQueue(): void {
  try {
    store?.set(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Persistence is best-effort; the in-memory queue remains owner-bound.
  }
}

export function enqueueAdEvent(event: QueuedAdEvent): void {
  queue.push(event);
  persistQueue();
}

export function hasQueuedAdEvents(): boolean {
  return queue.length > 0;
}

export function prepareAdEventBatch(scope: AdEventScope, now: number): QueuedAdEvent[] {
  queue = pruneQueue(queue, now);
  persistQueue();
  return takeBatchForScope(queue, scope, now);
}

export function settleAdEventBatch(
  sent: QueuedAdEvent[],
  verdicts: AdEventVerdict[] | null,
  now: number,
): void {
  queue = applyVerdicts(queue, sent, verdicts, now);
  persistQueue();
}

/** Exact captured-scope teardown: a delayed A retire cannot delete B. */
export function retireAdEventScope(scope: AdEventScope): void {
  queue = retireQueueScope(queue, scope);
  persistQueue();
}
