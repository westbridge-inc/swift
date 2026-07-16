/**
 * Off-platform contact detection (marketplace-mechanics spec §2).
 *
 * Detection, NOT censorship: a message carrying a phone number or a
 * take-it-to-WhatsApp overture still DELIVERS — the sender just gets a soft
 * nudge ("keep it in the app so you're covered"), and the message is flagged
 * so risk scoring can count repeat signals later. Hard-blocking frustrates
 * legitimate use ("the gate code is 4321") and teaches people to obfuscate.
 */

// 7+ digits in a row, tolerating spaces/dashes/dots between groups, guarded
// so alphanumeric codes (order numbers like SW-260715-001QDB) stay clean —
// catches
// "592 600 1000", "600-1000", "+5926001000". Order codes and prices are
// shorter or carry currency symbols.
const PHONE_PATTERN = /(?<![A-Za-z0-9-])(?:\+?\d[\s\-.()]?){7,}(?![A-Za-z0-9])/;

// Explicit take-it-off-platform overtures.
const OFF_PLATFORM_PATTERN = /whats\s?app|telegram|signal\s+me|call\s+me\s+(?:on|at)|text\s+me\s+(?:on|at)|imo\b/i;

export function detectOffPlatformContact(message: string): boolean {
  if (!message) return false;
  return PHONE_PATTERN.test(message) || OFF_PLATFORM_PATTERN.test(message);
}

export const OFF_PLATFORM_WARNING =
  'Keep it in the app — payments, proof and support only cover you here.';
