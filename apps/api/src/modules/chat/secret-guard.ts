/**
 * [F-027-12 · F-028-02] The handover secret must never travel over chat.
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
 * ── WHAT F-028-02 CORRECTED ───────────────────────────────────────────────
 * The first version of this guard closed the reported INSTANCE — a bare code
 * in one text body — and not the class. The review was right, and the file's
 * own doctrine had already stated the correct rule while the code did the
 * opposite:
 *
 *   1. It exempted a code appearing inside a LONGER number, and a test
 *      positively required that exemption. So "0" + the code plus "ignore the
 *      first digit" sailed through. That carve-out is GONE: the stated cost
 *      asymmetry — a false positive costs one redacted line, a false negative
 *      costs the delivery — only ever pointed one way.
 *   2. It matched ASCII literals only, so full-width digits, Arabic-Indic
 *      digits and spelled-out words were human-readable and unmatched. Text is
 *      now NORMALISED before matching.
 *   3. It judged each request alone, so "481" then "902" delivered a six-digit
 *      code in two intact messages. Matching now runs over the sender's recent
 *      digits as well as the current message.
 *
 * ── WHAT IT STILL DOES NOT CLOSE, STATED PLAINLY ──────────────────────────
 * Filtering an open channel for a secret is an arms race the filter loses in
 * the end. A photograph of the code, a voice note, or a private agreement
 * ("the number I said yesterday") all defeat any text guard. The invariant is
 * only truly closed by making a leaked code WORTHLESS — rotating it the moment
 * an attempt is detected, so the value already smuggled out is dead. That
 * requires re-issuing the code to the legitimate holder and is registered as
 * the follow-on rather than pretended at here. Nothing in this file should be
 * read as a claim that the channel is sealed.
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

/** The zero of each decimal digit system NFKC will not fold for us. Not the
 *  complete Unicode list — the realistic ones — and the guard degrades to
 *  leaving an unknown script's digits alone rather than mis-reading them. */
const DIGIT_SYSTEM_ZEROS = [
  0x0660, // Arabic-Indic
  0x06f0, // Extended Arabic-Indic (Persian/Urdu)
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Oriya
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
  0x0e50, // Thai
  0x0ed0, // Lao
  0x0f20, // Tibetan
  0x1040, // Myanmar
  0x17e0, // Khmer
  0x1810, // Mongolian
];

/** Digit words, plus the two spoken forms of zero people actually use. */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', nought: '0', naught: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

/**
 * Fold a message into a comparable form: every Unicode decimal digit becomes
 * its ASCII equivalent, and every STANDALONE digit word becomes its digit.
 *
 * Standalone matters — "someone" must not become "some1" and hand us a digit
 * that was never written. Only whole tokens convert.
 */
export function normaliseDigits(text: string): string {
  // NFKC folds the compatibility forms — full-width "４", mathematical and
  // enclosed variants — onto ASCII. `Number('４')` does NOT: it is NaN, which
  // is how the first version of this let full-width digits through.
  const compat = text.normalize('NFKC');
  // Scripts with their own decimal digits are not compatibility variants, so
  // NFKC leaves them alone. Each such system is a contiguous run of ten from
  // its zero, so the offset gives the value directly.
  const unicodeFolded = compat.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp === undefined || (cp >= 0x30 && cp <= 0x39)) return ch;
    for (const zero of DIGIT_SYSTEM_ZEROS) {
      if (cp >= zero && cp <= zero + 9) return String(cp - zero);
    }
    return ch;
  });
  return unicodeFolded.replace(/[A-Za-z]+/g, (word) => DIGIT_WORDS[word.toLowerCase()] ?? word);
}

/** Every digit in the text, in order, with everything else discarded. */
export function digitRun(text: string): string {
  return normaliseDigits(text).replace(/[^0-9]/g, '');
}

/**
 * Build a matcher for one code: its digits in order, tolerating short runs of
 * separators between them.
 *
 * The atoms are literal digits with a BOUNDED separator class between them —
 * no nested quantifiers — so this cannot backtrack catastrophically on
 * adversarial input.
 *
 * Note the absence of digit boundaries. A code embedded in a longer number is
 * matched ON PURPOSE (F-028-02): "here's my number 0481902, ignore the first
 * digit" is the attack, not a coincidence, and the file's cost asymmetry says
 * a wrongly-redacted phone number is the cheaper error by a wide margin.
 */
function matcherFor(code: string): RegExp | null {
  const digits = code.trim();
  // Only guard real codes. A 1–2 character "code" would redact ordinary
  // numbers everywhere ("2 bags", "apt 5") for no security gain.
  if (digits.length < 3 || !/^[0-9]+$/.test(digits)) return null;
  // Up to three separator characters between digits: enough for "481 - 902"
  // and "4. 8. 1.".
  const body = digits.split('').join('[^0-9A-Za-z]{0,3}');
  return new RegExp(body, 'g');
}

function liveCodes(secrets: OrderSecrets): string[] {
  return [secrets.ridePin, secrets.pickupCode].filter((c): c is string => !!c);
}

export interface RedactionResult {
  text: string;
  redacted: boolean;
  /** Present when the whole body was replaced rather than a substring. */
  wholeMessage?: boolean;
}

/**
 * Remove any live order code from free text.
 *
 * Two tiers, because obfuscation is evidence of intent:
 *
 *  - The code appears as literal digits ⇒ replace just that span. Ordinary
 *    text around it survives.
 *  - The code only appears once the text is NORMALISED (spelled out, or in
 *    non-ASCII digits) ⇒ replace the WHOLE body. Someone writing "four eight
 *    one nine zero two" is not making an incidental remark, and mapping the
 *    normalised match back onto the original indices would be fragile in
 *    exactly the cases that matter most.
 *
 * `priorDigits` carries the digits this sender has already put in the room
 * recently. Passing it lets a code split across messages be caught; omitting
 * it degrades to single-message behaviour rather than failing.
 *
 * Callers MUST use the returned text for storage, broadcast AND push —
 * persisting the original "for the record" puts the secret in the message
 * history, which is itself a disclosure channel.
 */
export function redactOrderSecrets(
  text: string,
  secrets: OrderSecrets,
  priorDigits = '',
): RedactionResult {
  if (!text) return { text, redacted: false };
  const codes = liveCodes(secrets);
  if (codes.length === 0) return { text, redacted: false };

  let out = text;
  let redacted = false;

  // Tier 1 — literal digits in the raw text.
  for (const code of codes) {
    const re = matcherFor(code);
    if (!re) continue;
    const next = out.replace(re, SECRET_REDACTION);
    if (next !== out) {
      out = next;
      redacted = true;
    }
  }
  if (redacted) return { text: out, redacted: true };

  // Tier 2 — visible only after normalisation, or only when joined to what
  // this sender already sent. Either way the body goes.
  const normalised = normaliseDigits(text);
  const joined = priorDigits + digitRun(text);
  for (const code of codes) {
    const re = matcherFor(code);
    if (!re) continue;
    if (re.test(normalised) || joined.includes(code)) {
      return { text: SECRET_REDACTION, redacted: true, wholeMessage: true };
    }
  }

  return { text, redacted: false };
}

/**
 * Does an attachment URL carry a live code?
 *
 * `mediaUrl` is an arbitrary sender-supplied string that is stored and emitted
 * to the other participant, so a path or query naming the code crosses the
 * channel untouched (F-028-02). A URL is not prose — there is nothing to
 * preserve around the secret, so the caller drops the attachment entirely
 * rather than mangling it into a broken link.
 */
export function mediaUrlCarriesSecret(mediaUrl: string | undefined | null, secrets: OrderSecrets): boolean {
  if (!mediaUrl) return false;
  const codes = liveCodes(secrets);
  if (codes.length === 0) return false;
  const digits = digitRun(mediaUrl);
  return codes.some((code) => {
    const re = matcherFor(code);
    return !!re && (re.test(normaliseDigits(mediaUrl)) || digits.includes(code));
  });
}
