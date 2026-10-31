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
 *
 * [G11] The same one question also answers whether the App Store and Google
 * Play links show (useAppStoresLive): on the public site only, and only once
 * the answer says "live", never while it is on its way or if it fails. Other
 * hosts (staging, previews, local runs) never show them and ask nothing new.
 */
type Answer = 'unknown' | 'live' | 'closed';

let answer: Answer = 'unknown';
let storesAnswer: Answer = 'unknown';
// [OPEN-EARLY] Did the server itself say "not open yet"? Only a real answer of "soon" sets it: an unanswered or
// failed question does not, so a sentence that is true only before launch never shows on a guess.
let saidSoon = false;
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function ask(): void {
  asking ??= fetch('/api/launch-state', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { webOrdering?: string; appStores?: string } | null) => {
      answer = body?.webOrdering === 'live' ? 'live' : 'closed';
      saidSoon = body?.webOrdering === 'soon';
      storesAnswer = body?.appStores === 'live' ? 'live' : 'closed';
    })
    .catch(() => { answer = 'closed'; storesAnswer = 'closed'; })
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

/**
 * [G11] True only on the public site, once the server's SWIFT_APP_STORES switch
 * answered "live" on this page load (elsewhere nothing asks, so it stays false).
 */
export function useAppStoresLive(): boolean {
  return useSyncExternalStore(subscribe, () => storesAnswer === 'live', () => false);
}

/**
 * [OPEN-EARLY] True only on the public site, once the server answered that ordering is not open yet ("soon") on
 * this page load. While the question is on its way, if it fails, once live, and on every other host (staging,
 * previews, local runs) it is false. For the pre-launch partner note ("we approve partners on launch day"),
 * which must never show after launch.
 */
export function useWebOrderingSoon(): boolean {
  return useSyncExternalStore(subscribe, () => isPublicSiteHost(window.location.host) && saidSoon, () => false);
}

/** Tests only: forget this page load's answer. */
export function forgetLaunchAnswer(): void {
  answer = 'unknown';
  storesAnswer = 'unknown';
  saidSoon = false;
  asking = null;
}
