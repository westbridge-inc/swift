// ═══════════════════════════════════════════════════════════════════════════
//  THE ONE FILE THE FOUNDER EDITS.  [SITE-1.1 Part 3 — the token protocol]
// ═══════════════════════════════════════════════════════════════════════════
//
//  Every company fact on swiftgy.com is read from this object. No legal name,
//  address or phone number is hardcoded anywhere else in the site — grep for
//  any of them and this file is the only hit.
//
//  ┌─────────────────────────────────────────────────────────────────────────┐
//  │  TO GO LIVE: replace every {{TOKEN}} below with the real value.         │
//  │                                                                         │
//  │  The legal entity name and address MUST be copied character-for-        │
//  │  character from the Dun & Bradstreet record. Apple compares the site    │
//  │  against D&B during organization enrollment; "Ltd" vs "Limited", a      │
//  │  missing comma, or a different street abbreviation is enough to fail    │
//  │  the check. Do not tidy the spelling.                                   │
//  │                                                                         │
//  │  The phone number must be one a human answers — Apple may call it.      │
//  └─────────────────────────────────────────────────────────────────────────┘
//
//  The build REFUSES to compile while any {{...}} token remains (see the
//  assertion at the bottom of this file). The site therefore cannot ship
//  half-filled: the two-minute fill is enforced, not requested.
//
//  IDENTITY LAW [SITE-1.1 Part 2]: the founder's personal name appears
//  nowhere on this site — not in a page, not in metadata, not in alt text.
//  The company speaks as the company.
//
// ═══════════════════════════════════════════════════════════════════════════

import { SITE_DOMAIN, SITE_ORIGIN } from './site.domain';

export const site = {
  /** Exact D&B spelling. Appears on /about, /contact and every footer. */
  legalEntityName: '{{LEGAL_ENTITY_NAME}}',

  /** Exact D&B address, one line. Apple matches this against the D&B record. */
  address: '{{COMPANY_ADDRESS}}',

  /** The number the founder actually answers. Apple may call it. */
  phone: '{{COMPANY_PHONE}}',

  /** Support inbox. Already live on the domain's mail — do not change. */
  supportEmail: 'support@swiftgy.com',

  /** Canonical apex host. www 301s here; AASA resolves here with no redirect.
   *  Declared in site.domain.ts so next.config can read it without tripping
   *  the unfilled-token guard below. */
  domain: SITE_DOMAIN,
} as const;

export { SITE_ORIGIN };

// ── Launch truth ───────────────────────────────────────────────────────────
//  Every availability claim on the site reads from here, so the marketing copy
//  can never drift ahead of what actually works. Apple and Google both treat a
//  dead call-to-action as a review flag, and a "Download on the App Store"
//  badge before the app exists is the fastest way to fail.
//
//  Flip a vertical to 'live' only when a customer in that market can complete
//  the flow end to end today.

export type LaunchState = 'live' | 'waitlist' | 'soon';

export const launch = {
  /** Where the product actually operates. Add a market only when it is real. */
  markets: ['Georgetown, Guyana'] as const,

  /** Ordering on the web works today; the native apps do not exist yet. */
  webOrdering: 'live' as LaunchState,
  iosApp: 'soon' as LaunchState,
  androidApp: 'soon' as LaunchState,

  verticals: {
    food: 'live' as LaunchState,
    groceries: 'live' as LaunchState,
    shops: 'live' as LaunchState,
    rides: 'live' as LaunchState,
    courier: 'live' as LaunchState,
    services: 'live' as LaunchState,
  },
} as const;

/** True only when a real, installable app exists in that store. Gates the
 *  store badges — see AC-10. There is deliberately no way to force a badge on. */
export const showAppStoreBadges = launch.iosApp === 'live' || launch.androidApp === 'live';

// ── The deploy gate ────────────────────────────────────────────────────────
//  [SITE-1.1 Part 3] "the build FAILS if any {{...}} token remains."
//
//  This module is imported by the root layout, so it is evaluated during
//  `next build` for every page. An unfilled token throws at build time and the
//  deploy never produces output — which is the point: a company site that
//  says "{{LEGAL_ENTITY_NAME}}" to a reviewer is worse than no site.
//
//  NEXT_PUBLIC_ALLOW_SITE_TOKENS=1 exists for local development only, so a
//  contributor can run the site without the founder's private company details
//  sitting in their working tree. It is never set in a deploy environment, and
//  the runbook does not mention it.

const TOKEN_PATTERN = /\{\{[A-Z_]+\}\}/;

export function unfilledTokens(): string[] {
  return Object.entries(site)
    .filter(([, value]) => typeof value === 'string' && TOKEN_PATTERN.test(value))
    .map(([key]) => key);
}

if (process.env['NEXT_PUBLIC_ALLOW_SITE_TOKENS'] !== '1') {
  const missing = unfilledTokens();
  if (missing.length > 0) {
    throw new Error(
      `\n\n  BUILD REFUSED — ${missing.length} company detail${missing.length === 1 ? '' : 's'} still unfilled in apps/web/src/site.config.ts:\n` +
        missing.map((k) => `    • ${k}`).join('\n') +
        `\n\n  Replace each {{TOKEN}} with the real value, copied character-for-character\n` +
        `  from the Dun & Bradstreet record. See SITE-1.1 Part 3.\n\n` +
        `  (Local development without the real details: NEXT_PUBLIC_ALLOW_SITE_TOKENS=1)\n`,
    );
  }
}
