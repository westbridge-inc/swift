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
  // [NO-AI] The owner removed every AI runtime from Swift, so the Privacy
  // Policy's "AI processing" paragraph — which told people their search terms
  // and menu text went to a model provider — became untrue. A policy that
  // describes processing which no longer happens is as wrong as one that hides
  // processing which does. It now says plainly that Swift sends nothing you
  // write to an AI service — AND names the one place a model does run (the
  // identity check), because the first draft of this paragraph claimed no model
  // existed anywhere while the KYC face-match was live. That claim is graded
  // against the processor register now; see legal-ai-claim.test.ts.
  //
  // All four documents re-pin, not only the Privacy Policy: the published
  // "Last updated" date is part of every served text, so changing it changes
  // each document's words. The 2026-08-30 entry above is untouched — those are
  // the words people actually consented to.
  //
  // Superseded by 2026-09-23 on the same unmerged branch (F-1218-02), before
  // it reached main. Its hashes stay exactly as pinned — any environment that
  // ran the branch holds them in its ledger, and the law above is the law.
  '2026-09-07': {
    terms: '585d5b6e5f147e945602fd3dce05a27509952563a9be2b6c2127524be6811c32',
    privacy: 'edad85c0a55cd9520d8e45ed0e0f504481b4d94030068bf0d25df63445a6d6f9',
    driver_agreement: '923d398238ff81c5b554673871eab012999b77a27742a2812afa965e5ffc7ead',
    vendor_agreement: '5023bc04a37935f4de6e873f400c8e8b35443164d46e7a951c0f72bbb93946d1',
  },
  // [F-1218-02] The 2026-09-07 "AI processing" paragraph said the identity
  // check's automated results "produce a flag for a person to review, never a
  // decision on their own". The document state machine licenses VALIDATED →
  // REJECTED on `auto_reject` and the verification service records a
  // provider's decline as REJECTED under `reviewedBy: 'kyc:auto'` — a machine
  // decision the sentence denied. The sentence now says what the check can do
  // (accept, reject, or refer to a person) and what follows a rejection (you
  // are told; you can resubmit or raise it through Help & Support): nothing
  // the code does not already do. Graded in legal-human-review-claim.test.ts.
  // The date moves with the words, so all four documents re-pin.
  '2026-09-23': {
    terms: '198ffa340ffddf7c13c4cbb304bd174779eca63bfd2dd87fcf435582f5f7a229',
    privacy: '92c78089c42557c575df043f47c315c3f6ff67dad75760a5e9e2e6b1b7d23091',
    driver_agreement: 'aea903e63b7620322010187556e385a501e6e0c82d3e25b1e4809a6cd94bc1a5',
    vendor_agreement: 'af8e9d090a0c2d5323c4b6e1433aacd9cd8e2d0a9cd04a57a536f1331d0dd9a8',
  },
  // [NO-AI · owner rule 2026-09-07, #1276] Identity documents are decided by a
  // person; the model-backed identity providers, the selfie face-match and the
  // in-shift selfie check are gone. The 2026-09-23 words described that removed
  // processing, so they stopped being true. Privacy: the processors list no
  // longer names an identity-verification provider, the "AI processing"
  // paragraph says a trained person reads and decides the document and that
  // there is no AI model in Swift (graded in legal-ai-claim and
  // legal-human-review-claim), and the verification-documents bullet no longer
  // points to a provider. Mover Agreement: no in-shift selfie check is claimed.
  // Terms: the preamble no longer claims Caribbean markets beyond Guyana, since
  // public signup is Guyana-only (#1259). The date moves with the words, so all
  // four documents re-pin; the 2026-09-23 entry above stays exactly as pinned.
  '2026-09-24': {
    terms: '50efa809026066e7b107001f57a49afc02e1c7620604617847e455a70bb2a5b6',
    privacy: '28dc34df68a42aece4779c76159f2ba304fe48cbc12b67f29c35ccddfb143200',
    driver_agreement: 'ef7089db0be6c27e7b446c95d875f30c2b31bbbd8a3b39a94355f9112f3fb159',
    vendor_agreement: '3672c61f804747d8977981bcee4c75ff4b9935808c00cd0fcd21800bf67f21e2',
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
