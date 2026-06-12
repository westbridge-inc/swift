// ---------------------------------------------------------------------------
// Prompt scrubber — hard rule 3: no PII, documents, or payment data ever
// reaches an external AI service. Every string headed for a prompt passes
// through here first. Deterministic, over-eager on purpose.
// ---------------------------------------------------------------------------

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Card-like digit runs (13-19 digits, allowing spaces/dashes) BEFORE phones
  { re: /\b(?:\d[ -]?){13,19}\b/g, label: '[redacted-card]' },
  // Phone numbers (international and local forms)
  { re: /\+?\d{7,15}\b/g, label: '[redacted-phone]' },
  // Email addresses
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: '[redacted-email]' },
  // JWTs / bearer-ish tokens
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, label: '[redacted-token]' },
  // Document storage references — raw documents never leave (hard rule 3)
  { re: /storage:\/\/\S+/g, label: '[redacted-document]' },
  { re: /\/uploads\/\S+/g, label: '[redacted-document]' },
  // Long opaque ids (cuid-ish) — nothing useful for language tasks anyway
  { re: /\bc[a-z0-9]{20,30}\b/g, label: '[redacted-id]' },
];

export function scrubPrompt(input: string): string {
  let out = input;
  for (const { re, label } of PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}
