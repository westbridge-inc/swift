// [CARD embed] The bank's card page shown INSIDE the weekly-fee page. The page is Swift's
// own API page around the bank's secure card form (CARD-CHECKOUT-API); this site frames
// only that page, only when the build turned it on, and never learns anything from it:
// whether a card payment happened is only ever the server's read of the session.

// Next's compiler requires this exact dot-form lookup for static replacement.
// The ambient member makes that syntax type-safe under noPropertyAccessFromIndexSignature.
/* eslint-disable no-unused-vars */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NEXT_PUBLIC_CARD_FRAME?: string;
    }
  }
}
/* eslint-enable no-unused-vars */

/** Set by next.config from SWIFT_WEB_CARD_FRAME, with the CSP frame-src for the API origin. */
export function cardFrameEnabled(): boolean {
  return process.env.NEXT_PUBLIC_CARD_FRAME === '1';
}

/**
 * As strict as the card page allows. Sandbox flags pass down to the frames inside it, and
 * the bank's form and its 3-D Secure pages need scripts, forms, their own origin (their
 * cookies) and a bank's popup; the return page's links may move this page only when the
 * partner taps. The same set the API's card page gives the bank's form.
 */
export const CARD_FRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation';

/** The server-issued card page, if it is on this site's API origin (the only origin the CSP lets it frame). */
export function cardFrameSrc(hostedUrl: string, apiOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(hostedUrl);
  } catch {
    return null;
  }
  if (url.origin !== apiOrigin || url.username || url.password) return null;
  return url.toString();
}
