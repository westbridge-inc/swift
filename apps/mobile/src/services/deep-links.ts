import { Linking } from 'react-native';
import { api } from './api';
import { safeNavigate } from '../navigation/navigationRef';

// The QR/link DEEP-LINK ROUTER [qr spec Part 6]. Universal links hand the app
// a full https URL for /store/{slug} or /s/{code}; this module turns it into
// the storefront screen — or a dedicated QR outcome, never an unrelated
// store or Home behind a transient toast. Same queue-and-flush shape as the notification tap-router:
// navigation not ready yet → queued, RootNavigator's onReady flushes.
//
// Android note: universal-link INTERCEPTION also needs assetlinks + intent
// filters (native config — the founder device pass); warm in-app links and
// the cold-start initial URL work everywhere today.

export { destinationForUrl, type LinkDestination } from '../lib/deepLinkParse';
import { destinationForUrl, setLinkDecisionObserver, type LinkDestination } from '../lib/deepLinkParse';
import { track } from '../lib/analytics';

/** Fire-and-forget APP_OPEN report (spec 8.2) — the OS intercepted the link,
 *  the web resolver never ran, so the app files the funnel event instead. */
function reportAppOpen(code: string | null): void {
  if (!code) return;
  void api.post(`/public/qr/${code}/app-open`, {}).catch(() => undefined);
}

let pendingUrl: string | null = null;
let installed = false;

/**
 * Why a code did not open a store. The IN-APP SCANNER needs these apart — the
 * person is standing at the counter holding the phone and "replaced" and "not
 * a Swift code" call for different next moves — and external links use the same truthful outcomes.
 *
 * `unavailable` never says WHY: the server deliberately collapses "no such
 * entity" and "not publicly live" into one verdict so the endpoint cannot be
 * used to enumerate stores, and repeating that reason here would undo it.
 */
export type ResolveFailure = 'not-a-swift-code' | 'replaced' | 'unavailable' | 'offline';
export type ResolveOutcome =
  | { ok: true; vendorId: string }
  | { ok: false; reason: ResolveFailure };

/**
 * ONE resolver for a scanned code and a tapped link. They are the same
 * question — "what store is this, and may it be shown?" — and the server owns
 * the answer. A second copy in the scanner is how the two would come to
 * disagree about a retired code.
 *
 * Also files the APP_OPEN funnel event, which is the reason
 * POST /qr/:code/app-open exists and has had no caller from the scanner path.
 */
export async function resolveDestination(dest: LinkDestination): Promise<ResolveOutcome> {
  try {
    if (dest.kind === 'short') {
      // The app-side twin of GET /s/:code — same classify, JSON instead of 302.
      const res = await api.get(`/public/qr/${dest.code}`);
      const data = res.data?.data as { verdict?: string; vendorId?: string | null } | undefined;
      reportAppOpen(dest.code);
      if (data?.verdict === 'WEB_RENDER' && data.vendorId) return { ok: true, vendorId: data.vendorId };
      if (data?.verdict === 'RETIRED_PAGE') return { ok: false, reason: 'replaced' };
      if (data?.verdict === 'UNAVAILABLE_PAGE') return { ok: false, reason: 'unavailable' };
      return { ok: false, reason: 'not-a-swift-code' };
    }
    // /store/{slug}: the public storefront endpoint resolves slug → id.
    const res = await api.get(`/public/storefronts/${dest.slug}`);
    const vendorId = (res.data?.data as { id?: string } | undefined)?.id;
    reportAppOpen(dest.code);
    return vendorId ? { ok: true, vendorId } : { ok: false, reason: 'unavailable' };
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) return { ok: false, reason: dest.kind === 'short' ? 'not-a-swift-code' : 'unavailable' };
    if (status === 410) return { ok: false, reason: 'replaced' };
    // A dead network is NOT a dead code. Saying "this code is invalid" to
    // someone holding a perfectly good printed sign is the lie this separates.
    return { ok: false, reason: 'offline' };
  }
}

async function resolveAndGo(dest: LinkDestination, request: number): Promise<void> {
  const outcome = await resolveDestination(dest);
  if (request !== latestRequest) return;
  if (outcome.ok) {
    safeNavigate('Storefront', { screen: 'Restaurant', params: { vendorId: outcome.vendorId } });
    return;
  }
  safeNavigate('QrOutcome', { reason: outcome.reason, destination: dest, requestId: request });
}

let navReady = false;
let latestRequest = 0;

/** The two fixed fee returns: MMG's page and the card page (CARD-CHECKOUT-API section 7). */
export function isWeeklyFeeReturn(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'swift:' && parsed.hostname === 'pay' && (parsed.pathname === '/mmg/return' || parsed.pathname === '/card/return'); } catch { return false; }
}

function handleUrl(url: string | null): boolean {
  if (!url) return false;
  if (isWeeklyFeeReturn(url)) {
    // A newer fee return supersedes pending scans and discards all parameters.
    latestRequest += 1;
    pendingUrl = null;
    if (!safeNavigate('WeeklyFee') && !navReady) pendingUrl = 'swift://pay/mmg/return';
    return true;
  }
  const dest = destinationForUrl(url);
  if (!dest) return false; // not ours — the app opens normally
  const request = ++latestRequest;
  if (!navReady) {
    pendingUrl = url;
    return true;
  }
  void resolveAndGo(dest, request);
  return true;
}

/** Retry only the currently displayed scan. A later external link or an
 * uninstalled handler wins over a slow retry, just as it wins over initialURL. */
export async function retryQrDestination(destination: LinkDestination, requestId: number): Promise<void> {
  if (!navReady || requestId !== latestRequest) return;
  await resolveAndGo(destination, ++latestRequest);
}

/** RootNavigator onReady: deliver the URL that launched a cold start. */
export function flushPendingDeepLink(): void {
  navReady = true;
  if (!pendingUrl) return;
  const url = pendingUrl;
  pendingUrl = null;
  handleUrl(url);
}

/** Install once at app start: warm URLs via the listener, cold start via the
 *  initial URL. Failures are silent — the app opening at all is the meal. */
export function installDeepLinkHandler(): () => void {
  if (installed) return () => undefined;
  installed = true;
  let active = true;
  let receivedWarmLink = false;
  // [MOB-002] Every origin decision is counted: accepted by origin, rejected by
  // reason (deep_link_accepted / deep_link_rejected). analytics.track is the
  // one seam events leave through, and today it is a no-op by design.
  setLinkDecisionObserver((d) => {
    if (d.kind === 'accepted') track('deep_link_accepted', { origin: d.origin });
    else track('deep_link_rejected', { reason: d.reason });
  });
  const sub = Linking.addEventListener('url', ({ url }) => {
    try { receivedWarmLink = handleUrl(url) || receivedWarmLink; } catch { /* never crash on a link */ }
  });
  Linking.getInitialURL()
    .then((url) => {
      // Initial URL and onReady can finish in either order. A new tap wins
      // over a late initial URL; a stopped listener never navigates later.
      if (active && !receivedWarmLink) handleUrl(url);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    latestRequest += 1;
    pendingUrl = null;
    navReady = false;
    installed = false;
    setLinkDecisionObserver(null);
    sub.remove();
  };
}

/** Test seam. */
export function resetDeepLinksForTests(): void {
  pendingUrl = null;
  navReady = false;
  installed = false;
  latestRequest = 0;
}
