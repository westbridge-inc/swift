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
import { OPERATOR } from './legal/generated';
import { launch } from './site.launch';

/** [Owner 15 Oct 2026; hours 30 Oct 2026: 8:00–16:00] Support's days and hours, in Guyana time. */
const SUPPORT_DAYS = 'Monday to Saturday, 8:00–16:00 Guyana time';

export const site = {
  // [Owner 15 Oct 2026 · legal research A11, R2] The company's identity has ONE source, shared with the Terms
  // and the Privacy Policy: apps/api/src/modules/legal/operator.ts, through the legal:sync snapshot. To change
  // a fact, change it there (a legal-text change: new LEGAL_VERSION) and run legal:sync.

  /** The operator's legal name. Appears on /about, /contact and every footer. */
  legalEntityName: OPERATOR.name,

  /** Registration number of the company (Guyana). */
  registrationNo: OPERATOR.registrationNo,

  /** The registered address, one line. */
  address: `${OPERATOR.registeredAddress}, ${OPERATOR.registeredIn}`,

  /** The number the founder actually answers. Apple may call it. */
  phone: OPERATOR.phone,

  /** Support inbox. Already live on the domain's mail — do not change. */
  supportEmail: OPERATOR.supportEmail,

  /** [Owner 31 Oct 2026] Sales inbox for chains and enterprise (the pricing page's Contact sales button). */
  salesEmail: 'sales@swiftgy.com',

  /** [Owner 15 Oct 2026] When support answers. The one source for the days and hours: the home page's trust strip
   *  shows it as is, and supportHours below builds on it. */
  supportDays: SUPPORT_DAYS,

  /** [Owner 15 Oct 2026] When support answers, and what to do in an emergency. No page may promise faster. */
  supportHours: `${SUPPORT_DAYS} (in-app Help & Support). In an emergency use SOS or call Police 911, Fire 912, Ambulance 913.`,

  /** Canonical apex host. www 301s here; AASA resolves here with no redirect.
   *  Declared in site.domain.ts so next.config can read it without tripping
   *  the unfilled-token guard below. */
  domain: SITE_DOMAIN,

  // ── [Q36] What the card bank requires the site to state ─────────────────
  //  The bank is sent a screenshot of each of these and may visit the site.
  //  /about, /legal/refunds, /legal/delivery and every footer read them here.

  /** The name the service trades under, and the other way it is written. */
  tradeName: 'Swift',
  tradeNameAlt: 'SwiftGY',

  /** Where the company is officially registered and located. */
  registeredCity: 'Georgetown',

  /** The domicile country, and the only country Swift operates in. */
  country: 'Guyana',
  countryCode: 'GY',

  /** The transaction currency: every price on Swift is in Guyana dollars. */
  currencyCode: 'GYD',
  currencyName: 'Guyana dollars',

  /** How soon support answers a question about a Swift charge, in business days. */
  supportReplyBusinessDays: 2,
} as const;

export { SITE_ORIGIN };

// ── Launch truth: src/site.launch.ts (re-exported here) ─────────────────────
export { launch };
export type { LaunchState } from './site.launch';

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
