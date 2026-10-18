import { AppError } from '../../utils/errors';
import { storeWordHit } from '../compliance/prohibited-items';

/**
 * [R3 · CAA s.70(3) · legal research D10 + E5 · owner 15 Oct 2026] The store's OWN refund rule: the words its
 * storefront shows under "Refunds", followed by the statutory-rights sentence. Typed by the store's owner (it is
 * the store's commitment, not Swift's), in plain words:
 *  - whitespace is collapsed and the ends trimmed; an empty rule takes it down (null → "Ask the store");
 *  - at most REFUND_RULE_MAX characters, so it reads as a rule and not an advert;
 *  - no links or web addresses — the rule itself goes on the page, never a pointer to somewhere Swift cannot see;
 *  - the same judge as the store's own words (GUARDRAILS §8): a rule naming goods Swift never carries is refused.
 * Refused words never replace the rule on file.
 */
export const REFUND_RULE_MAX = 300;
const LINK = /[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;

/** undefined = not sent (leave as is); null = take the rule down; otherwise the cleaned words. */
export function refundRuleForWrite(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > REFUND_RULE_MAX) {
    throw new AppError(400, 'REFUND_RULE_INVALID', `Keep your refund rule to ${REFUND_RULE_MAX} characters or fewer.`);
  }
  if (LINK.test(text)) {
    throw new AppError(400, 'REFUND_RULE_INVALID', 'Write your refund rule in plain words, without links or web addresses.');
  }
  if (storeWordHit({ name: '', description: text })) {
    throw new AppError(400, 'REFUND_RULE_INVALID', 'Your refund rule names goods Swift never carries. Reword it without them.');
  }
  return text;
}
