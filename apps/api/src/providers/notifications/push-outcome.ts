import { log } from '../../utils/logger';
import { pushFailuresCounter } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// [STORE-ALERT 18 Oct 2026] Every push that does not reach a phone leaves a
// structured log line and a count. Before this the Expo adapter dropped every
// refused ticket except DeviceNotRegistered without a word, never read a
// receipt, and the vendor re-alert swallowed its own failures, so "the store
// phone never rang" had no trace anywhere.
//
// What is recorded is the CLASS of failure only: never the push token, the
// person, a phone number or the message text. `kind` is the notification kind
// (a code constant such as vendor_order_alert), clipped.
// ---------------------------------------------------------------------------

/** Expo's documented push ticket / receipt error classes. Anything else is
 *  recorded as 'other' so the metric label set stays bounded. */
export const EXPO_PUSH_ERROR_CLASSES = [
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MessageTooBig',
  'MessageRateExceeded',
  'MismatchSenderId',
] as const;

const KNOWN = new Set<string>(EXPO_PUSH_ERROR_CLASSES);

export function expoErrorClass(raw: unknown): string {
  return typeof raw === 'string' && KNOWN.has(raw) ? raw : 'other';
}

/** One failed HTTP attempt to Expo, by what went wrong. */
export type PushRequestFailure = 'timeout' | 'network' | 'http_429' | 'http_4xx' | 'http_5xx' | 'bad_response';

export function httpFailureReason(status: number): PushRequestFailure {
  if (status === 429) return 'http_429';
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

export type PushFailureStage = 'request' | 'ticket' | 'receipt';

export function recordPushFailure(
  stage: PushFailureStage,
  reason: string,
  count: number,
  context: { kind?: unknown } = {},
): void {
  if (count <= 0) return;
  pushFailuresCounter.inc({ stage, reason }, count);
  const kind = typeof context.kind === 'string' ? context.kind.slice(0, 64) : undefined;
  log().warn({ event: 'push_failure', stage, reason, count, ...(kind ? { kind } : {}) }, 'push did not reach a phone');
}

/** Tally error classes, then record each class once. */
export function recordPushFailureClasses(
  stage: PushFailureStage,
  rawErrors: unknown[],
  context: { kind?: unknown } = {},
): void {
  const tally = new Map<string, number>();
  for (const raw of rawErrors) {
    const reason = expoErrorClass(raw);
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of tally) recordPushFailure(stage, reason, count, context);
}
