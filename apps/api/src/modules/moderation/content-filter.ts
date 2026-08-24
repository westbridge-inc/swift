import { AppError } from '../../utils/errors';

/**
 * The server-side objectionable-content seed list. Keep entries short and
 * unambiguous: a word-list filter is a first submission gate, not a substitute
 * for the report queue or human review.
 *
 * CONTENT_FILTER_EXTRA_WORDS may add comma-separated whole words at runtime.
 * Seeds cannot be removed by configuration.
 */
export const OBJECTIONABLE_CONTENT_SEED = [
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'cunt',
  'bastard',
  'skunt',
  'antiman',
  'buller',
] as const;

type ContentValue = string | readonly string[] | null | undefined;

function normalizedWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9']+/g, ' ')
      .split(' ')
      .filter(Boolean),
  );
}

function normalizeTerm(term: string): string {
  const words = [...normalizedWords(term)];
  return words.length === 1 ? words[0]! : '';
}

export function configuredObjectionableTerms(): string[] {
  return (process.env['CONTENT_FILTER_EXTRA_WORDS'] ?? '')
    .split(',')
    .map((term) => normalizeTerm(term))
    .filter(Boolean);
}

/** Whole-word, case-blind match shared by rejection and rating-hold paths. */
export function containsObjectionableContent(text: string, extraTerms: readonly string[] = []): boolean {
  const words = normalizedWords(text);
  return [...OBJECTIONABLE_CONTENT_SEED, ...extraTerms]
    .map((term) => normalizeTerm(term))
    .filter(Boolean)
    .some((term) => words.has(term));
}

/**
 * Reject public or participant-visible text before it is stored. Deliberately
 * do not call this for reports, support/safety narratives, disputes, or other
 * evidence: those channels must be able to quote the abuse being reported.
 */
export function assertAcceptableContent(fields: Readonly<Record<string, ContentValue>>): void {
  const extraTerms = configuredObjectionableTerms();
  const rejectedFields = Object.entries(fields)
    .filter(([, value]) => {
      const values = Array.isArray(value) ? value : [value];
      return values.some((candidate) => (
        typeof candidate === 'string'
        && containsObjectionableContent(candidate, extraTerms)
      ));
    })
    .map(([field]) => field);

  if (rejectedFields.length > 0) {
    throw new AppError(
      400,
      'OBJECTIONABLE_CONTENT',
      'Please remove objectionable language and try again.',
      { fields: rejectedFields },
    );
  }
}
