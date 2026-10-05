/**
 * [L13 item 7 · owner decision 4] Remote crash reporting for build 10.
 *
 * OFF unless the build carries a usable crash-report address
 * (EXPO_PUBLIC_SENTRY_DSN, supplied by the owner as an EAS environment
 * variable, never committed). The address points at Swift's self-hosted,
 * Sentry-protocol error tracker (see the API's processor register).
 *
 * Privacy: no default PII, no user is ever set, no breadcrumbs at all
 * (maxBreadcrumbs 0, JS and native), no session replay, screenshots, view
 * tree, thread dumps, tracing, sessions or network capture. JavaScript events
 * also pass `crash-scrub` on the phone.
 *
 * Native crash capture is ON (coordinator ruling, 5 Oct: native crashes are the
 * most important class). Native reports are written by the native SDK and do
 * NOT pass the JavaScript scrubber, which is why everything above is switched
 * off at the source. What a native report carries: the crashing thread's
 * stack, the exception type and message, release/build, environment, OS
 * (name, version, build), device hardware (model, family, architecture,
 * memory/storage, screen, orientation, battery, simulator flag), app context
 * (bundle id, version, start time) and locale/timezone. The native SDKs also
 * attach a RANDOM per-install identifier as the event's user id (not the
 * account, not the phone number). With sendDefaultPii false they attach no IP
 * address and no device name.
 *
 * The SDK plugs into the existing dependency-free `crash-reporter` seam: the
 * error boundary's reports are captured here, while uncaught global errors are
 * left to the SDK's own global handler (installed by init), so a crash is
 * never reported twice.
 */
import { setCrashReporter } from './crash-reporter';
import { scrubCrashBreadcrumb, scrubCrashEvent } from './crash-scrub';

export interface CrashSdk {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): unknown;
}

let started = false;

// https://<public key>[:<secret>]@<host>[:port]/<optional path>/<numeric project id>
// Parsed with a pattern, not URL(): React Native's URL support is partial.
const DSN_SHAPE = /^https:\/\/[^:@/\s]+(?::[^@/\s]*)?@[^/\s:@]+(?::\d+)?\/(?:[^\s?#]+\/)?\d+\/?$/;

/** A trimmed https DSN with a key and a numeric project, or null (reporting stays off). */
export function usableDsn(dsn: string | undefined): string | null {
  const value = dsn?.trim();
  if (!value) return null;
  return DSN_SHAPE.test(value) ? value : null;
}

export function crashSdkOptions(dsn: string, environment: string): Record<string, unknown> {
  return {
    dsn,
    environment,
    sendDefaultPii: false,
    enableNative: true,
    enableNativeCrashHandling: true,
    attachThreads: false,
    tracesSampleRate: 0,
    enableAutoPerformanceTracing: false,
    enableUserInteractionTracing: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: false,
    enableAutoSessionTracking: false,
    enableNetworkBreadcrumbs: false,
    enableNetworkTracking: false,
    enableSwizzling: false,
    maxBreadcrumbs: 0,
    beforeSend: (event: object) => scrubCrashEvent(event),
    beforeBreadcrumb: (crumb: object) => scrubCrashBreadcrumb(crumb),
  };
}

/** Start remote reporting once, if the DSN is usable. Never throws: a failed start leaves it off. */
export function startCrashReporting(sdk: CrashSdk, config: { dsn: string | undefined; environment: string }): boolean {
  if (started) return true;
  const dsn = usableDsn(config.dsn);
  if (!dsn) return false;
  try {
    sdk.init(crashSdkOptions(dsn, config.environment));
  } catch {
    return false;
  }
  started = true;
  setCrashReporter((error, context) => {
    if (context?.['source'] === 'global') return; // the SDK's own global handler already has it
    sdk.captureException(error, context ? { extra: context } : undefined);
  });
  return true;
}

export function resetCrashReportingForTests(): void {
  started = false;
  setCrashReporter(null);
}

/** The environment label, from the build's API origin — never a guess that mixes staging into production. */
export function crashEnvironment(apiUrl: string | undefined, isDev: boolean): string {
  if (isDev) return 'development';
  const host = /^https:\/\/([^/:?#]+)/.exec(apiUrl?.trim() ?? '')?.[1]?.toLowerCase();
  if (host === 'api.swiftgy.com') return 'production';
  if (host === 'api-staging.swiftgy.com') return 'staging';
  return 'other';
}
