import type { LaunchState } from '@/site.config';

/**
 * [Item 7 · S1 · owner ruling 6 Oct: "a server-side flip-any-time switch"]
 * May the PUBLIC site (swiftgy.com and www) take orders? Read from the web
 * server's own environment while it runs — SWIFT_WEB_ORDERING=live opens it;
 * anything else, or nothing, keeps the "Launching soon" front door. It is not
 * a NEXT_PUBLIC_ value, so no build bakes it in: changing it takes effect when
 * the site restarts with the new setting, and turning ordering back off in an
 * emergency is the same one change. Closed is the default everywhere.
 *
 * Only the server reads it (middleware.ts, app/api/launch-state); the browser
 * asks the server (lib/use-web-ordering.ts).
 */
export const LAUNCH_SWITCH_ENV = 'SWIFT_WEB_ORDERING';

export function webOrderingState(env: Record<string, string | undefined> = process.env): LaunchState {
  return env[LAUNCH_SWITCH_ENV] === 'live' ? 'live' : 'soon';
}
