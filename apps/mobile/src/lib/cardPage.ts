// The bank's card page, shown INSIDE Swift (CARD-CHECKOUT-API). The page is Swift's own
// server page around the bank's secure card form; the card is typed only in that form.
// These rules decide where the in-app card sheet may go. They never decide payment state:
// a return, a closed sheet or a page the bank shows is only ever a reason to ask the server.
import { CARD_RETURN } from './cardFee';

/** The card provider's hosts (the server pins its gateway to this domain too). Never shown to a partner. */
const PROVIDER_HOST = /^(?:[a-z0-9-]+\.)*ptranz\.com$/i;
/** The server's return route (the card provider's MerchantResponseUrl). */
const RETURN_PATH = '/api/v1/billing/card/return';
/** Frame documents a page creates for itself (the bank's form is bound into a srcdoc frame). */
const OWN_FRAME_DOCUMENTS = new Set(['about:blank', 'about:srcdoc']);

export type CardPageDecision = 'allow' | 'block' | 'return';

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The origin of the API this app talks to: the only Swift origin the card sheet may show. */
export function cardApiOrigin(apiUrl: string | null | undefined): string | null {
  const url = apiUrl ? parse(apiUrl) : null;
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return url.origin;
}

/** A page the sheet's MAIN frame may show: Swift's own API origin, or the card provider over https. */
export function cardMainFrameAllowed(raw: string, apiOrigin: string): boolean {
  const url = parse(raw);
  if (!url || url.username || url.password) return false;
  if (url.origin === apiOrigin) return true;
  return url.protocol === 'https:' && (url.port === '' || url.port === '443') && PROVIDER_HOST.test(url.hostname);
}

/** The partner asked to go back to Swift (the return page's and the card page's own link). */
export function isCardReturnLink(raw: string): boolean {
  return raw === CARD_RETURN || raw.startsWith(`${CARD_RETURN}?`) || raw.startsWith(`${CARD_RETURN}#`);
}

/** The server's return page reached the MAIN frame (the simulator's flow): the page is done. */
export function isCardReturnPage(raw: string, apiOrigin: string): boolean {
  const url = parse(raw);
  return !!url && url.origin === apiOrigin && url.pathname === RETURN_PATH;
}

/**
 * One navigation the card sheet is about to make.
 *  - The return link closes the sheet (the server is then asked what happened).
 *  - Nothing but https, Swift's own API origin and the page's own frame documents ever
 *    loads: no other app is opened (tel:, intent:, a store link), no file or script URL.
 *  - The MAIN frame shows only Swift's API origin or the card provider. A frame inside
 *    the page may also show the card's bank over https (3-D Secure challenge pages live on
 *    each bank's own host); the server's page policy already limits its frames to https.
 *  - `isTopFrame` is reported by iOS only. Android cannot tell a frame from the main frame
 *    here, so the main-frame rule is enforced again when a main-frame load starts
 *    (`cardMainFrameAllowed`), which both platforms report for the main frame only.
 */
export function cardPageDecision(nav: { url: string; isTopFrame?: boolean }, apiOrigin: string): CardPageDecision {
  const raw = nav.url ?? '';
  if (isCardReturnLink(raw)) return 'return';
  if (OWN_FRAME_DOCUMENTS.has(raw)) return nav.isTopFrame === true ? 'block' : 'allow';
  const url = parse(raw);
  if (!url || url.username || url.password) return 'block';
  if (url.origin !== apiOrigin && url.protocol !== 'https:') return 'block';
  if (nav.isTopFrame === true) return cardMainFrameAllowed(raw, apiOrigin) ? 'allow' : 'block';
  return 'allow';
}

/** A main-frame load is starting somewhere the sheet must not go: the sheet closes instead. */
export function cardMainFrameLeft(raw: string | null | undefined, apiOrigin: string): boolean {
  return !!raw && raw !== 'about:blank' && !cardMainFrameAllowed(raw, apiOrigin);
}

/** The server issued a card page this sheet can show (else the in-app browser opens it, as before). */
export function cardPageEmbeddable(hostedUrl: string, apiOrigin: string | null): boolean {
  return !!apiOrigin && cardMainFrameAllowed(hostedUrl, apiOrigin);
}

/**
 * Where the card page opens: the in-app card sheet when this build has its web view and the
 * page is on this app's own API origin (or the card provider's); otherwise null, and the
 * in-app browser opens it exactly as before. A build without the web view (store builds 9
 * and 10) never gets past the first line.
 */
export function cardSheetFor<V>(url: string, webView: () => V | null, apiUrl: () => string | null | undefined): { WebView: V; apiOrigin: string } | null {
  const WebView = webView();
  if (!WebView) return null;
  let apiOrigin: string | null = null;
  try { apiOrigin = cardApiOrigin(apiUrl()); } catch { apiOrigin = null; }
  return apiOrigin && cardPageEmbeddable(url, apiOrigin) ? { WebView, apiOrigin } : null;
}
