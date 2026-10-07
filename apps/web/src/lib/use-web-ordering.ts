import { useSyncExternalStore } from 'react';
import { isPublicSiteHost } from './web-ordering';

/**
 * [Item 7 · S1] The pre-launch switch, as the page the visitor is on sees it.
 *
 * The server renders the closed state. In the browser:
 *  - on a host that keeps the marketplace (staging, a preview, a local run)
 *    it is open at once, whatever the switch says;
 *  - on the public site it asks the server once per page load
 *    (/api/launch-state, read while the server runs), and stays closed until
 *    the answer says "live" — and if the question fails.
 * A public page therefore never shows an ordering button the server has not
 * opened.
 */
type Answer = 'unknown' | 'live' | 'closed';

let answer: Answer = 'unknown';
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function ask(): void {
  asking ??= fetch('/api/launch-state', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { webOrdering?: string } | null) => { answer = body?.webOrdering === 'live' ? 'live' : 'closed'; })
    .catch(() => { answer = 'closed'; })
    .finally(() => { for (const listener of listeners) listener(); });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (isPublicSiteHost(window.location.host)) ask();
  return () => { listeners.delete(listener); };
}

function snapshot(): boolean {
  return !isPublicSiteHost(window.location.host) || answer === 'live';
}

export function useWebOrderingOpen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Tests only: forget this page load's answer. */
export function forgetLaunchAnswer(): void {
  answer = 'unknown';
  asking = null;
}
