// ---------------------------------------------------------------------------
// [Apple 3.1.1 / 3.1.3(e)] What the weekly partner fee may say, per platform.
//
// The weekly fee is what a business pays to operate on Swift: they receive
// orders, they deliver real goods to real people, and they keep 100% of every
// fare and tip. That is a REAL-WORLD SERVICE, and guideline 3.1.3(e) says
// services consumed outside the app must use payment methods OTHER than
// in-app purchase — so Apple's IAP is not merely unnecessary here, it is the
// wrong instrument. Every comparable charges partners this way: Uber,
// DoorDash, Shopify, Square, Etsy.
//
// The exposure is not the payment. It is the READING. A screen that shows a
// number, a copy button and numbered steps for sending money to a merchant
// account can be read by a reviewer as steering an in-app purchase to an
// external channel — 3.1.1 — even though the thing being bought is a real
// business relationship. The same screen, showing what is owed and when,
// reads as an account statement, which is what it is.
//
// So iOS keeps every fact and drops the instructions. Android keeps both:
// Play has no equivalent restriction on real-world service fees, and a
// partner on Android who cannot reach a browser still needs to know how to
// pay. This is NOT a different feature set per platform — the money, the
// amounts, the dates and the account number are identical, and DL-6 (no
// behaviour that branches on who is looking) is untouched: this branches on
// the STORE'S RULES, which are public, not on the person.
//
// When live MMG credentials land, the honest replacement for the instructions
// is a Pay now button: mmg-provider.ts already implements the whole
// merchant-initiated loop, and in that flow the partner approves the charge in
// MMG's own app rather than entering anything into Swift. That is a weaker
// payment surface than the steps this removes, not a stronger one.
// ---------------------------------------------------------------------------

export type FeePlatform = 'ios' | 'android' | 'web';

export interface FeeSurface {
  /** The amount owed, the due date, weeks covered — always shown. */
  showStatus: boolean;
  /** The Swift Number itself. An account identifier, not a payment method. */
  showAccountNumber: boolean;
  /** Numbered "take cash to an agent" instructions. */
  showPaymentSteps: boolean;
  /** Where a partner is pointed instead, when the steps are not shown. */
  alternative: string | null;
}

/**
 * The account number STAYS on iOS.
 *
 * It is how a partner is identified on their own account — the same role a
 * customer number plays on a utility bill — and it appears on the receipts and
 * statements they already receive. Removing it would hide a fact about their
 * own account to satisfy a rule about purchases, which is the kind of
 * over-correction that makes a screen useless without making it safer.
 *
 * What goes is the step-by-step instruction to send money somewhere.
 */
export function feeSurfaceFor(platform: FeePlatform): FeeSurface {
  if (platform === 'ios') {
    return {
      showStatus: true,
      showAccountNumber: true,
      showPaymentSteps: false,
      alternative: 'We text you the payment steps with every reminder, and they are on your account page at swiftgy.com.',
    };
  }
  return { showStatus: true, showAccountNumber: true, showPaymentSteps: true, alternative: null };
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
