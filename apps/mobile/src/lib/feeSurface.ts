// All platforms render server payActions; legacy payment instructions are retired.
export type FeePlatform = 'ios' | 'android' | 'web';
export function feeSurfaceFor(_platform: FeePlatform) {
  return { showStatus: true, showAccountNumber: false, showPaymentSteps: false, alternative: null };
}

/**
 * The framing that decides which guideline a reviewer reaches for.
 *
 * "Upgrade", "Pro", "Premium", "unlock" describe buying a tier of an app —
 * 3.1.1, IAP required. The weekly fee buys none of those things: it is the
 * cost of operating a business that delivers physical goods. The words have to
 * say so, because the words are the only evidence a reviewer has about which
 * kind of thing this is.
 */
export const FEE_FRAMING = 'Your weekly Swift fee — you keep 100% of every delivery, fare and tip.';

/** Words that would move this screen into the in-app-purchase reading. */
const PURCHASE_WORDS = ['upgrade', 'unlock', 'premium', 'pro plan', 'subscribe now', 'buy now', 'in-app purchase'];

export function framingProblem(copy: string): string | null {
  const found = PURCHASE_WORDS.filter((w) => copy.toLowerCase().includes(w));
  if (found.length === 0) return null;
  return `"${found[0]}" describes buying a tier of an app. This fee buys the right to run a real business — say that instead.`;
}
