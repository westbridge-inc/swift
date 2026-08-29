import { Linking } from 'react-native';
import { api } from './api';
import { safeNavigate } from '../navigation/navigationRef';
import { toast } from '../kit/toast';

// The QR/link DEEP-LINK ROUTER [qr spec Part 6]. Universal links hand the app
// a full https URL for /store/{slug} or /s/{code}; this module turns it into
// the storefront screen — or an honest toast + normal open, never a crash,
// never a guess. Same queue-and-flush shape as the notification tap-router:
// navigation not ready yet → queued, RootNavigator's onReady flushes.
//
// Android note: universal-link INTERCEPTION also needs assetlinks + intent
// filters (native config — the founder device pass); warm in-app links and
// the cold-start initial URL work everywhere today.

export { destinationForUrl, type LinkDestination } from '../lib/deepLinkParse';
import { destinationForUrl, type LinkDestination } from '../lib/deepLinkParse';

/** Fire-and-forget APP_OPEN report (spec 8.2) — the OS intercepted the link,
 *  the web resolver never ran, so the app files the funnel event instead. */
function reportAppOpen(code: string | null): void {
  if (!code) return;
  void api.post(`/public/qr/${code}/app-open`, {}).catch(() => undefined);
}

const FAIL_TOAST = "That link didn't work — here's home instead.";

let pendingUrl: string | null = null;
let installed = false;

/**
 * Why a code did not open a store. The IN-APP SCANNER needs these apart — the
 * person is standing at the counter holding the phone and "replaced" and "not
 * a Swift code" call for different next moves — whereas a deep link that
 * already dumped them on Home only needs one apology.
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
  } catch {
    // A dead network is NOT a dead code. Saying "this code is invalid" to
    // someone holding a perfectly good printed sign is the lie this separates.
    return { ok: false, reason: 'offline' };
  }
}

async function resolveAndGo(dest: LinkDestination): Promise<void> {
  const outcome = await resolveDestination(dest);
  if (outcome.ok) {
    if (!safeNavigate('Restaurant', { vendorId: outcome.vendorId })) throw new Error('nav');
    return;
  }
  // A network failure must still THROW here. handleUrl's catch is what queues a
  // cold-start link for RootNavigator's onReady to flush, and on a cold start
  // the request can fail simply because the app is still coming up. Swallowing
  // it would turn a link that used to open on the retry into a dead toast.
  // resolveDestination folds that case into a value for the scanner's benefit;
  // this path puts it back.
  if (outcome.reason === 'offline') throw new Error('resolve');
  toast.show(FAIL_TOAST);
}

let navReady = false;

function handleUrl(url: string | null): void {
  if (!url) return;
  const dest = destinationForUrl(url);
  if (!dest) return; // not ours — the app opens normally
  resolveAndGo(dest).catch(() => {
    // Navigation not ready (cold start) → queue; RootNavigator's onReady
    // flushes. Genuine resolve failures once ready (retired code, dead
    // store, offline) → honest toast, the app stays on Home.
    if (!navReady && pendingUrl === null) {
      pendingUrl = url;
    } else {
      toast.show(FAIL_TOAST);
    }
  });
}

/** RootNavigator onReady: deliver the URL that launched a cold start. */
export function flushPendingDeepLink(): void {
  navReady = true;
  if (!pendingUrl) return;
  const url = pendingUrl;
  pendingUrl = null;
  setTimeout(() => handleUrl(url), 300);
}

/** Install once at app start: warm URLs via the listener, cold start via the
 *  initial URL. Failures are silent — the app opening at all is the meal. */
export function installDeepLinkHandler(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const sub = Linking.addEventListener('url', ({ url }) => {
    try { handleUrl(url); } catch { /* never crash on a link */ }
  });
  Linking.getInitialURL()
    .then((url) => { if (url) { pendingUrl = url; } })
    .catch(() => undefined);
  return () => {
    installed = false;
    sub.remove();
  };
}

/** Test seam. */
export function resetDeepLinksForTests(): void {
  pendingUrl = null;
  navReady = false;
  installed = false;
}
