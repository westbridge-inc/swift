import { randomInt } from 'node:crypto';

// The Swift Account Number (SAN) — the universal payment reference for
// platform fees [san spec PART 2]. 10 numeric digits: first 1-9 (survives
// spreadsheet/terminal truncation), last = Luhn check digit over the first 9.
// Luhn catches every single-digit typo and every adjacent transposition
// except 09<->90 — exactly the errors an agent makes keying a number read
// aloud, so a typo fails AT THE COUNTER instead of crediting a stranger.
// SANs are random (never sequential — sequences leak account counts and
// invite enumeration), immutable, and never recycled.

/** payload = 9 digits; returns the 10th (rightmost) check digit. */
export function luhnCheckDigit(payload: string): string {
  let sum = 0;
  const digits = payload.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits[i]!;
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function luhnValid(san: string): boolean {
  if (!/^[1-9][0-9]{9}$/.test(san)) return false;
  let sum = 0;
  const digits = san.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i += 1) {
    let d = digits[i]!;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const FORBIDDEN = [
  /^(\d)\1{8}$/, // 9 identical digits
  /^123456789$/,
  /^987654321$/,
];

export function generateSanPayload(): string {
  const first = randomInt(1, 10); // 1..9 (max exclusive)
  let p = String(first);
  for (let i = 0; i < 8; i += 1) p += String(randomInt(0, 10));
  if (FORBIDDEN.some((r) => r.test(p))) return generateSanPayload();
  return p;
}

/** One fresh candidate SAN. Uniqueness is the DB's job (SanAssignment PK);
 *  callers redraw on unique-violation. Payload space 9x10^8 — at 1M accounts
 *  a draw collides ~0.11% of the time. */
export function generateSan(): string {
  const payload = generateSanPayload();
  return payload + luhnCheckDigit(payload);
}

/** Strip every non-digit — agents and humans type spaces, dashes, dots. */
export function normalizeSan(raw: string): string {
  return raw.replace(/\D+/g, '');
}

/** Display grouping `123 456 7890` — read-aloud friendly, and the grouping the
 *  design actually specifies.
 *
 *  This used to render XXX-XXX-XXXX. Both group in threes and both read aloud
 *  the same, so it looked like a free choice — but it is not one. The rendered
 *  pay screen, the printable counter card and every reminder message show the
 *  number with SPACES, and a Swift Account Number is a thing a vendor reads off
 *  a phone to an MMG agent who keys it into a terminal. When the number on the
 *  screen and the number on the printed card are punctuated differently, the
 *  person at the counter has to decide whether they are the same number. They
 *  are, and they should never have to wonder.
 *
 *  `normalizeSan` strips every non-digit, so anyone who types dashes out of
 *  habit still resolves to the same account. Only the display changes. */
export function formatSan(san: string): string {
  return `${san.slice(0, 3)} ${san.slice(3, 6)} ${san.slice(6)}`;
}

export type SanValidationFailure = 'SAN_MALFORMED' | 'SAN_CHECKSUM_FAILED';

/** The entry half of the validation pipeline [spec 2.2]:
 *  normalize -> length -> leading-digit -> Luhn. DB resolution (SAN_UNKNOWN /
 *  ACCOUNT_CLOSED / NOT_FEE_LIABLE / TOMBSTONED) is the service's half. */
export function validateSanShape(raw: string): { ok: true; san: string } | { ok: false; code: SanValidationFailure } {
  const san = normalizeSan(raw);
  if (!/^[1-9][0-9]{9}$/.test(san)) return { ok: false, code: 'SAN_MALFORMED' };
  if (!luhnValid(san)) return { ok: false, code: 'SAN_CHECKSUM_FAILED' };
  return { ok: true, san };
}

/** Masking law [spec 4.2]: first letter + bullets + city — enough for "yes,
 *  that's me" at the counter, nothing more (DPA). */
export function maskDisplayName(name: string, city?: string | null): string {
  const trimmed = name.trim();
  const masked = trimmed ? `${trimmed[0]}${'•'.repeat(Math.max(3, Math.min(6, trimmed.length - 1)))}` : '••••';
  return city ? `${masked} (${city})` : masked;
}
