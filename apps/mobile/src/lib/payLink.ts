import { Linking } from 'react-native';
import type { MmgDirectPaymentAction } from '@swift/types';

// expo-web-browser is a NATIVE module: on a binary built before it was added,
// importing it throws. Load it through a guarded require so a stale build falls
// back to the system browser instead of crashing at startup — same lesson as
// netinfo/expo-task-manager (see reference_swift_native_module_crash).
let WebBrowser: typeof import('expo-web-browser') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  WebBrowser = require('expo-web-browser');
} catch {
  WebBrowser = null;
}

/**
 * Open a vendor's / driver's MMG "pay me" link **in-app** — a fast in-app
 * browser (SFSafariViewController on iOS, Custom Tabs on Android) that overlays
 * Swift and returns to it, so the customer never leaves the app to pay. Falls
 * back to the system browser if the in-app-browser module isn't in this native
 * build yet. Never throws.
 */
export async function openPayLink(url?: string | null): Promise<boolean> {
  if (!url) return false;
  try {
    if (WebBrowser?.openBrowserAsync) {
      await WebBrowser.openBrowserAsync(url);
      return true;
    }
  } catch {
    // fall through to the system browser
  }
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    // malformed / unopenable link — nothing more we can do
    return false;
  }
}

function isPublicPaymentHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || !hostname.includes('.')) return false;
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home.arpa')
  ) return false;
  // The API applies the authoritative exact-host allowlist. The client adds a
  // second invariant: a payment action can never target an IP literal.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || rawHostname.startsWith('[')) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) && !hostname.includes('..');
}

/**
 * The URL invariants EVERY money link must satisfy, however it reached us.
 *
 * These lived inside `safeMmgPaymentActionUrl`, which only accepts the
 * server-issued action object — so a raw "pay me" string had no way to be
 * checked, and the driver pay link in RidePostTripSheet was opened straight
 * from `ride.driver.mmgPayUrl` with no validation at all. A link that decides
 * where a customer's money goes is exactly the wrong place to trust a bare
 * string, so the shape check now stands on its own and both callers use it.
 */
export function safePayUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || (parsed.port && parsed.port !== '443')
    || !isPublicPaymentHostname(parsed.hostname)
  ) return null;
  return parsed.toString();
}

/** Defense in depth for the one server-issued post-checkout action. The client
 * does not invent/accept a raw vendor URL and does not try to duplicate the
 * server's deployment allowlist. */
export function safeMmgPaymentActionUrl(action: MmgDirectPaymentAction | null | undefined): string | null {
  if (
    action?.kind !== 'OPEN_EXTERNAL_URL'
    || action.method !== 'MOBILE_MONEY'
    || action.provider !== 'MMG'
    || action.fundsFlow !== 'DIRECT_TO_VENDOR'
  ) return null;
  return safePayUrl(action.url);
}

export async function openMmgPaymentAction(
  action: MmgDirectPaymentAction | null | undefined,
  opener: (url: string) => Promise<boolean | void> = openPayLink,
): Promise<boolean> {
  const url = safeMmgPaymentActionUrl(action);
  if (!url) return false;
  return (await opener(url)) !== false;
}
