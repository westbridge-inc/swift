/**
 * SWIFT-013: mobile crash visibility. The app shipped with NO ErrorBoundary and
 * NO global JS error handler, so an uncaught render error or an async throw
 * crashed to a blank screen with nothing captured — day-one crashes invisible,
 * and every fix gated behind store-review latency.
 *
 * This is the dependency-free safety net: catch the error, always log it, and
 * route it to a PLUGGABLE reporter. Remote reporting (Sentry/etc.) plugs in via
 * `setCrashReporter` once a DSN is provisioned (a founder credential) — until
 * then the error is logged instead of silently swallowed. No SDK dependency is
 * pulled in here, so this ships without waiting on that credential.
 */
type CrashContext = Record<string, unknown>;
type Reporter = (error: Error, context?: CrashContext) => void;

let reporter: Reporter | null = null;

/** Install (or clear) the remote reporter — e.g. a Sentry adapter once a DSN exists. */
export function setCrashReporter(fn: Reporter | null): void {
  reporter = fn;
}

/**
 * Route a caught error to the reporter (if any) and ALWAYS log it. Coerces
 * non-Error throws, and a reporter that itself throws can never crash the crash
 * handler.
 */
export function reportCrash(error: unknown, context?: CrashContext): void {
  const err = error instanceof Error ? error : new Error(String(error));
  // eslint-disable-next-line no-console
  console.error('[crash]', err.message, context ?? '');
  try {
    reporter?.(err, context);
  } catch {
    // a downstream reporter failure must never mask or replace the original crash
  }
}

/**
 * Wire React Native's global handler so an uncaught error OUTSIDE the React
 * render tree (timers, event handlers, async) is captured instead of vanishing.
 * Chains any previously installed handler (so RN's redbox/native crash still
 * fires). No-ops outside a RN runtime (e.g. unit tests) where ErrorUtils is absent.
 */
export function installGlobalErrorHandler(): void {
  const g = globalThis as {
    ErrorUtils?: {
      getGlobalHandler?: () => ((e: unknown, isFatal?: boolean) => void) | undefined;
      setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
    };
  };
  const EU = g.ErrorUtils;
  if (!EU?.setGlobalHandler) return;
  const prev = EU.getGlobalHandler?.();
  EU.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    reportCrash(error, { fatal: !!isFatal, source: 'global' });
    prev?.(error, isFatal); // preserve RN's own fatal handling (redbox / native report)
  });
}
