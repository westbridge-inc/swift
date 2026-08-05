// ---------------------------------------------------------------------------
// Movement R (R7) — the review text pipeline, pure. Phone patterns (local
// +592 / 7-digit formats), emails and URLs are MASKED before storage; a
// profanity/slur list (en + seeded local terms, admin-extendable via config)
// auto-HOLDS the review for moderation instead of publishing. Masking never
// blocks publication — reporting handles what masking can't.
// ---------------------------------------------------------------------------

const PHONE_RE = /(\+?\d[\d\s().-]{5,}\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const URL_RE = /(https?:\/\/\S+|www\.\S+)/gi;

/** Mask contact channels — reviews talk about the food, not off-platform. */
export function maskPii(text: string): string {
  return text
    .replace(URL_RE, '[link removed]')
    .replace(EMAIL_RE, '[email removed]')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 7 ? '[number removed]' : m))
    .replace(/\s{3,}/g, ' ')
    .trim();
}

/** Seed list (en + local) — deliberately short and unambiguous; admins extend
 *  via config, never trim the seeds. Matching is whole-word, case-blind. */
const PROFANITY_SEED = [
  'fuck', 'fucking', 'shit', 'bitch', 'asshole', 'cunt', 'bastard',
  'skunt', 'antiman', 'buller', // local slurs — held, reviewed by a human
];

export function needsProfanityHold(text: string, extra: string[] = []): boolean {
  const words = new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9']+/g, ' ')
      .split(' ')
      .filter(Boolean),
  );
  return [...PROFANITY_SEED, ...extra.map((w) => w.toLowerCase())].some((w) => words.has(w));
}

/** One call for the submission path: masked text + hold verdict. */
export function processReviewText(text: string, extraProfanity: string[] = []): { text: string; hold: boolean } {
  const masked = maskPii(text);
  return { text: masked, hold: needsProfanityHold(masked, extraProfanity) };
}
