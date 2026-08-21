/**
 * [F-027-12] The handover secret must never travel over chat.
 *
 * Chat's standing doctrine is DETECTION, NEVER CENSORSHIP (see off-platform.ts):
 * a message carrying a phone number still delivers, because hard-blocking
 * frustrates legitimate use and teaches people to obfuscate. The order's
 * pickup/ride code is the ONE deliberate exception, and it is not a
 * moderation call — it is the control itself.
 *
 * The code exists to prove one thing: the driver physically met the customer.
 * The moment it can be typed into a room the driver is in, that proof is gone
 * — and the classic fraud writes itself ("just send me the code and I'll mark
 * it delivered"). Worse, the message body is copied verbatim into the other
 * participants' PUSH payloads, so the secret lands on a lock screen: the exact
 * channel the handover invariant names.
 *
 * So a live code is removed before the message is stored, broadcast, or
 * pushed — never merely flagged — and the sender is told plainly why, so the
 * removal does not read as the app silently mangling their text.
 *
 * Matching is deliberately generous: the control is defeated just as
 * thoroughly by "1 2 3 4 5 6" or "code: 123-456" as by the bare digits. A
 * false positive costs one redacted line in a chat; a false negative costs
 * the delivery.
 */

/** The codes the order behind a room holds RIGHT NOW. Verified codes are still
 *  secrets — a re-verification or a dispute can turn on them. */
export interface OrderSecrets {
  ridePin?: string | null;
  pickupCode?: string | null;
}

export const SECRET_REDACTION = '[code removed]';

export const SECRET_REDACTED_WARNING =
  'We removed the pickup code from your message. Only show it in person — anyone who asks for it in chat is trying to close your order without completing it.';

/**
 * Build a matcher for one code: its digits in order, tolerating short runs of
 * separators between them, and not part of a longer number.
 *
 * The atoms are literal digits with a BOUNDED separator class between them —
 * no nested quantifiers — so this cannot backtrack catastrophically on
 * adversarial input.
 */
function matcherFor(code: string): RegExp | null {
  const digits = code.trim();
  // Only guard real codes. A 1–2 character "code" would redact ordinary
  // numbers everywhere ("2 bags", "apt 5") for no security gain.
  if (digits.length < 3 || !/^[0-9]+$/.test(digits)) return null;
  // Up to three separator characters between digits: enough for "481 - 902"
  // and "4. 8. 1.", short enough that unrelated numbers in a sentence do not
  // chain into a false match.
  const body = digits.split('').join('[^0-9A-Za-z]{0,3}');
  return new RegExp(`(?<![0-9])${body}(?![0-9])`, 'g');
}

/**
 * Remove any live order code from free text.
 *
 * Returns the text to store/broadcast/push and whether anything was removed.
 * Callers MUST use the returned text for all three — persisting the original
 * "for the record" puts the secret in the message history, which is itself a
 * disclosure channel.
 */
export function redactOrderSecrets(
  text: string,
  secrets: OrderSecrets,
): { text: string; redacted: boolean } {
  if (!text) return { text, redacted: false };
  let out = text;
  let redacted = false;
  for (const code of [secrets.ridePin, secrets.pickupCode]) {
    if (!code) continue;
    const re = matcherFor(code);
    if (!re) continue;
    const next = out.replace(re, SECRET_REDACTION);
    if (next !== out) {
      out = next;
      redacted = true;
    }
  }
  return { text: out, redacted };
}
