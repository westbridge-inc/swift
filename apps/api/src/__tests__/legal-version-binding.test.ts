import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION, TERMS, PRIVACY } from '../modules/legal/legal.routes';

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
const PUBLISHED: Record<string, { terms: string; privacy: string }> = {
  // The current pack: #758's wording under its own version at last.
  '2026-08-24': {
    terms: 'e79dede26e967583451ea2bba3fc1c482fdd20cf3137529f1d3506ab3f7d5508',
    privacy: '99579f6f1a58bbd619f1ca7216c1bdc75cfc1b6a4de840111159c9420f76f312',
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
