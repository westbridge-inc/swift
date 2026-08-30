import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION, TERMS, PRIVACY, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';

// ---------------------------------------------------------------------------
// [REPORT-035 F-035-08 · S1] Every served legal text is BOUND to its version.
//
// The consent ledger is immutable per (documentType, version, locale): the
// publisher throws on a same-version different-hash row. So when #758 changed
// the Privacy wording WITHOUT bumping LEGAL_VERSION, every long-lived
// database that already held the old row answered every consented
// registration with a 500 — signup was broken against any environment that
// existed before the words changed, and green against a fresh one, which is
// how it hid.
//
// This file makes that mistake a build failure. THE LAW:
//   - Change a single served word → bump LEGAL_VERSION and LAST_UPDATED in
//     legal.routes.ts, ADD a new entry here with the new hashes, and run
//     `pnpm --filter @swift/web legal:sync` (the public site's CI compares
//     its snapshot against the same source).
//   - NEVER edit an existing entry's hashes: a published version's words are
//     legal evidence. Rewriting the pin here is rewriting history — if you
//     think an old entry is wrong, that is a founder conversation.
// ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Every version ever served, pinned to the exact words it served. */
const PUBLISHED: Record<
  string,
  { terms: string; privacy: string; driver_agreement?: string; vendor_agreement?: string }
> = {
  // #758's wording under its own version.
  '2026-08-24': {
    terms: 'e79dede26e967583451ea2bba3fc1c482fdd20cf3137529f1d3506ab3f7d5508',
    privacy: '99579f6f1a58bbd619f1ca7216c1bdc75cfc1b6a4de840111159c9420f76f312',
  },
  // The lawyer-grade pack (founder directive 2026-08-30): full clause
  // architecture under Guyana law — DPA 2023 legal bases, automated-decision
  // human-review guarantee, marketplace/agency structure, consumer-rights
  // carve-outs, courts of Guyana. Every claim code-true.
  '2026-08-30': {
    terms: '8828417b725e7bb499170be5d1810c2f2e1725fcac24550b0e0967d1f59eaddb',
    privacy: '89bdfbe887313d8d6934d1c7293b9b4ed9a4e14555f21fe8ca8ef4675e5eb0da',
    // The role agreements' first published version — REQUIRED_CONSENTS had
    // declared them since the ledger shipped; these are the words that make
    // the declaration real, captured at partner provisioning.
    driver_agreement: 'da8d8ef8e1bbc7afc0dbf6c4b37da9255ef6447de0b1fca93572a68aed423753',
    vendor_agreement: '9d6454a303b4246dc928909752c2941c3c4f249fec7548c8c3c92cdd84eb16b3',
  },
};

describe('legal version binding [F-035-08]', () => {
  it('the served version is a version this file has pinned', () => {
    expect(
      Object.keys(PUBLISHED),
      `LEGAL_VERSION ${LEGAL_VERSION} has no pinned hashes — add its entry (see the law at the top of this file)`,
    ).toContain(LEGAL_VERSION);
  });

  it('the served words match their version pin — words never change under a stamp', () => {
    const pin = PUBLISHED[LEGAL_VERSION]!;
    const guidance =
      'The served legal text changed without a version bump. Bump LEGAL_VERSION + LAST_UPDATED in legal.routes.ts, ADD a new entry to PUBLISHED (never edit an old one), and run `pnpm --filter @swift/web legal:sync`.';
    expect(sha256(TERMS), guidance).toBe(pin.terms);
    expect(sha256(PRIVACY), guidance).toBe(pin.privacy);
    if (pin.driver_agreement) expect(sha256(DRIVER_AGREEMENT), guidance).toBe(pin.driver_agreement);
    if (pin.vendor_agreement) expect(sha256(VENDOR_AGREEMENT), guidance).toBe(pin.vendor_agreement);
  });

  it('the version is a date stamp, and LAST_UPDATED must move with it (shape check)', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The human form is rendered into both documents — same date, or the
    // page contradicts its own version.
    const [y, m, d] = LEGAL_VERSION.split('-').map(Number);
    const human = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
    expect(TERMS, `TERMS should carry "Last updated: ${human}"`).toContain(human);
    expect(PRIVACY, `PRIVACY should carry "Last updated: ${human}"`).toContain(human);
  });
});
