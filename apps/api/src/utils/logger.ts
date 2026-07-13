import type { FastifyBaseLogger } from 'fastify';

// A tiny logger registry so deep services (order, dispatch) can emit
// orderId-tagged trace lines without threading a logger param through every
// route that constructs them. Set once at boot from the Fastify logger;
// defaults to console so unit tests that construct services outside the app
// never crash. This is the correlation backbone for tracing one order across
// checkout → dispatch → accept → deliver (pre-launch audit H6).

type Loggable = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;

let current: Loggable = console;

export function setAppLogger(logger: Loggable): void {
  current = logger;
}

export function log(): Loggable {
  return current;
}
