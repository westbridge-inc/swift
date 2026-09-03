// ---------------------------------------------------------------------------
// [R048-008] THE CANONICAL RATING-TAG REGISTRY.
//
// The taxonomy seeded public slugs with hyphens (`unsafe-driving`) while the
// safety bridge compared underscore identifiers (`unsafe_driving`): no
// comparison ever matched, so a customer choosing "Unsafe driving" opened no
// incident — and the S1 tag, "not the driver shown", was never seeded at all.
//
// One vocabulary now. A canonical tag ID is the seeded slug: lowercase,
// hyphenated. Every ingress canonicalises what it receives (an underscore
// alias is accepted and emitted canonical), the safety map is keyed on the
// canonical form and typed, and the seed carries every safety tag for the
// roles that can be rated for safety.
// ---------------------------------------------------------------------------

export type SafetyTag = 'different-driver' | 'harassment' | 'felt-unsafe' | 'unsafe-driving' | 'impaired-driving';

export interface SafetyTagDef {
  category: 'IDENTITY_MISMATCH' | 'SAFETY_HARASSMENT' | 'DRIVING_DANGEROUS';
  /** Most severe first: the tag that decides the case's category when several are chosen. */
  order: number;
  label: string;
  /** The rated roles this tag is seeded for. */
  roles: ReadonlyArray<'DRIVER' | 'RIDER'>;
}

export const SAFETY_TAGS: Readonly<Record<SafetyTag, SafetyTagDef>> = Object.freeze({
  'different-driver': { category: 'IDENTITY_MISMATCH', order: 0, label: 'Not the driver shown', roles: ['DRIVER'] },
  'harassment': { category: 'SAFETY_HARASSMENT', order: 1, label: 'Harassment', roles: ['DRIVER', 'RIDER'] },
  'felt-unsafe': { category: 'SAFETY_HARASSMENT', order: 2, label: 'I felt unsafe', roles: ['DRIVER', 'RIDER'] },
  'unsafe-driving': { category: 'DRIVING_DANGEROUS', order: 3, label: 'Unsafe driving', roles: ['DRIVER'] },
  'impaired-driving': { category: 'DRIVING_DANGEROUS', order: 4, label: 'Seemed impaired', roles: ['DRIVER'] },
});

export const SAFETY_TAG_ORDER: ReadonlyArray<SafetyTag> = (Object.keys(SAFETY_TAGS) as SafetyTag[]).sort((a, b) => SAFETY_TAGS[a].order - SAFETY_TAGS[b].order);

/** A tag as it is stored and compared: trimmed, lowercased, hyphenated. Underscores and spaces are aliases. */
export function canonicalTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function canonicalTags(raw: ReadonlyArray<string> | null | undefined): string[] {
  const out: string[] = [];
  for (const r of raw ?? []) {
    const c = canonicalTag(r);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export function isSafetyTag(tag: string): tag is SafetyTag {
  return Object.prototype.hasOwnProperty.call(SAFETY_TAGS, tag);
}

/** The most severe safety tag among a rating's (canonical) tags, or null. */
export function mostSevereSafetyTag(tags: ReadonlyArray<string>): SafetyTag | null {
  const canon = canonicalTags(tags);
  return SAFETY_TAG_ORDER.find((t) => canon.includes(t)) ?? null;
}
