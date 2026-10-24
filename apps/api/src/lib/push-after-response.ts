import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';

/**
 * [PERF item 3] A partner's tap (a store accepting an order, a driver arriving) used to wait
 * for the push to the customer's phone: an HTTPS call to the push provider with its own
 * retries (after 2 s and 8 s) and an 8 s deadline per try, so a slow provider held the tap
 * for up to about 34 s, and a healthy one still added a round trip to another continent.
 *
 * Inside a route opened with `pushAfterResponse`, the inbox row and the socket events stay in
 * the request (durable and in order, before the answer); only the provider call goes on after
 * the answer, with the same retries, the same failure log and counter. It is no less durable
 * than before: the retries were in this process then too, and shutdown waits for these sends
 * (`drainPushesAfterResponse`) under the same cleanup deadline that held in-flight requests.
 *
 * Everything else is unchanged: workers, a send that must know whether it reached a phone
 * (sendReach), and fee demands (their own handoff ledger) still wait for the provider.
 *
 * Two things follow from the scope (#1917 review S4-1/S4-2), both benign:
 * - Async work STARTED inside such a request (a lazy timer, a void-ed promise) inherits the
 *   scope, so a push it sends also goes after the answer. Those sends are tracked and drained
 *   like the rest, and sendReach / fee demands still wait whatever the scope.
 * - The pushes from one tap, or two quick taps, are no longer handed to the provider in a
 *   fixed order. Providers never guaranteed delivery order anyway; the inbox rows and socket
 *   events, written inside the request, keep the order.
 */
const scope = new AsyncLocalStorage<true>();
const inFlight = new Set<Promise<void>>();

/** Route hook (onRequest): the pushes this request causes do not hold its answer. */
export function pushAfterResponse(_request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void {
  scope.run(true, done);
}

/** Starts `send` without waiting for it when the current request opted in, and says so.
 *  Returns false outside such a request: the caller then awaits `send` itself, as before. */
export function sendPushAfterResponse(send: () => Promise<void>): boolean {
  if (scope.getStore() !== true) return false;
  const running: Promise<void> = send()
    .catch(() => undefined) // `send` logs and counts its own failure; never an unhandled rejection
    .finally(() => { inFlight.delete(running); });
  inFlight.add(running);
  return true;
}

/** Shutdown: wait for the pushes still on their way (each bounded by its own deadline and retries). */
export async function drainPushesAfterResponse(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** How many pushes are still on their way (tests and the shutdown log). */
export function pushesAfterResponseInFlight(): number {
  return inFlight.size;
}
