// Ads creative pre-screen (ads-platform spec §10.4) — ADVISORY ONLY, the same
// law as the AI ID analyzer: it assists the human reviewer, it NEVER decides.
// The review queue shows the annotations; approval stays a human action, and a
// pre-screen failure must never block or fail an upload.
//
// Provider-interfaced per the standing orders (swappable, env kill switch,
// timeout). ADS_PRESCREEN_PROVIDER: 'heuristic' (default — deterministic,
// no external calls, no creds) | 'off'. An LLM-backed provider can slot in
// later behind founder-supplied credentials; NO PII/document rule stays —
// ad creatives are advertiser-submitted marketing content.

export interface AdPreScreenInput {
  kind: 'IMAGE' | 'VIDEO';
  headline?: string | null;
  body?: string | null;
  ctaLabel?: string | null;
  destinationType?: string | null;
  destinationValue?: string | null;
  restrictedCategories?: Record<string, boolean> | null; // AdsSettings.restrictedCategories
}

export interface AdPreScreenResult {
  provider: string;
  ok: boolean; // false = "worth a closer look", NEVER an auto-reject
  flags: Array<{ code: string; note: string }>;
  at: string; // ISO timestamp
}

export interface AdPreScreenProvider {
  screen(input: AdPreScreenInput): Promise<AdPreScreenResult>;
}

// Restricted-category lexicons (tenant law/policy via AdsSettings §19). Small
// and transparent by design — a reviewer can see exactly why a flag exists.
const CATEGORY_TERMS: Record<string, string[]> = {
  alcohol: ['rum', 'beer', 'whisky', 'whiskey', 'vodka', 'liquor', 'alcohol', 'brewery', 'wine'],
  gambling: ['casino', 'bet', 'betting', 'lottery', 'jackpot', 'odds', 'wager', 'raffle'],
  political: ['vote', 'election', 'party', 'candidate', 'campaign rally', 'ballot'],
};

/**
 * PLATFORM DEFAULT — what gets flagged when a tenant has configured nothing.
 *
 * `AdsSettings.restrictedCategories` is nullable with no database default, so
 * every tenant starts at `null` and the screening loop below used to iterate an
 * empty object: alcohol and gambling creative sailed through with the reviewer
 * never even seeing an annotation. That is not a safe place to start from, and
 * it is the difference between answering an app-store age-rating questionnaire
 * honestly and answering it wrong.
 *
 * These stay ADVISORY like everything else here — a default flag adds a note
 * for the human reviewer and never blocks an upload. A tenant that genuinely
 * permits a category still wins, because an explicit `false` from its settings
 * overrides the default in the merge below.
 */
const PLATFORM_DEFAULT_RESTRICTED: Record<string, boolean> = {
  alcohol: true,
  gambling: true,
  political: true,
};

const SUPERLATIVE_CLAIMS = ['#1', 'no. 1', 'number one', 'best in guyana', 'guaranteed', 'cheapest', '100% free'];

export class HeuristicAdPreScreenProvider implements AdPreScreenProvider {
  async screen(input: AdPreScreenInput): Promise<AdPreScreenResult> {
    const flags: Array<{ code: string; note: string }> = [];
    const text = [input.headline, input.body, input.ctaLabel].filter(Boolean).join(' ').toLowerCase();

    // Restricted categories (§19): the platform's safe default, with the
    // tenant's own settings layered on top so an explicit `false` still wins.
    const restricted = { ...PLATFORM_DEFAULT_RESTRICTED, ...(input.restrictedCategories ?? {}) };
    for (const [category, on] of Object.entries(restricted)) {
      if (!on) continue;
      const terms = CATEGORY_TERMS[category] ?? [];
      const hit = terms.find((t) => text.includes(t));
      if (hit) flags.push({ code: 'RESTRICTED_CATEGORY', note: `Text mentions "${hit}" (${category} is restricted for this tenant).` });
    }

    // Unverifiable superlative claims → MISLEADING_CLAIM candidates (§10.3).
    const claim = SUPERLATIVE_CLAIMS.find((c) => text.includes(c));
    if (claim) flags.push({ code: 'POSSIBLE_MISLEADING_CLAIM', note: `Contains "${claim}" — verify the claim is substantiated.` });

    // Shouting headline reads as low-quality (§10.3 TEXT_UNREADABLE cousin).
    const headline = input.headline ?? '';
    const letters = headline.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 8 && letters === letters.toUpperCase()) {
      flags.push({ code: 'ALL_CAPS_HEADLINE', note: 'Headline is fully capitalized.' });
    }

    // Destination sanity: URL type must actually be an http(s) URL.
    if (input.destinationType === 'URL' && input.destinationValue && !/^https?:\/\//i.test(input.destinationValue)) {
      flags.push({ code: 'LANDING_PAGE_SUSPECT', note: 'Destination is typed URL but is not an http(s) link.' });
    }

    return { provider: 'heuristic', ok: flags.length === 0, flags, at: new Date().toISOString() };
  }
}

export function getAdPreScreenProvider(): AdPreScreenProvider | null {
  const kind = (process.env['ADS_PRESCREEN_PROVIDER'] ?? 'heuristic').toLowerCase();
  switch (kind) {
    case 'off':
      return null; // kill switch — uploads carry no annotation at all
    case 'heuristic':
    default:
      return new HeuristicAdPreScreenProvider();
  }
}

/** Placeholder-free note: an LLM provider (e.g. vision screening) is founder-
 *  gated on credentials, exactly like PowerTranz — when added it implements
 *  AdPreScreenProvider and registers here; nothing else changes. */
