import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LEGAL_VERSION, TERMS, PRIVACY, DRIVER_AGREEMENT, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { FREE_CANCEL_WINDOW_MIN } from '../modules/order/cancel-policy';

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
  // [DOMAIN-1 · owner 2026-09-24] The contact addresses named swift.gy, a domain
  // Swift does not own: privacy@ and childsafety@ now read @swiftgy.com (Terms §22,
  // the Privacy Policy's controller, emergency-contact and rights paragraphs, the
  // Child Safety Standards). Nothing else in the words moved; this was checked
  // mechanically: the 2026-09-23 source with the domain, version and date swapped
  // equals this source apart from its comment. The date moves with the words, so all
  // four documents re-pin; the 2026-09-23 entry stays exactly as consented.
  '2026-09-24': {
    terms: '961a3916b1002dd5eb8d5725654baee1813830f362d4d06dc7877cf49f2a92df',
    privacy: '04bb7a2408b822ab897d49d4ea1ba5a58f97472786881054a0cd9177fa409048',
    driver_agreement: 'b82cc69dafaf15e5a61dcb58e5bf925ca2ee483ab5b804b3775b9c34d3fdf2f1',
    vendor_agreement: '3672c61f804747d8977981bcee4c75ff4b9935808c00cd0fcd21800bf67f21e2',
  },
  // [LEGAL-FEE · owner 2026-09-29] Partner weekly fees use MMG's checkout
  // in the Swift app, or card where offered — no agent or Swift Number.
  // Only those two payment clauses change; the shared last-updated date
  // changes all four hashes. Every previously published pin stays intact.
  '2026-09-30': {
    terms: 'aaaeb7f005377df71401298b1b5f6ac289d8930d8d5dd7ac29455843eaca3940',
    privacy: '3607dc2de84b9e22e6931cfcd297f842fdddcf452496e0789a84a70adedfcf59',
    driver_agreement: '7e560184f2106df06f56b95888d6dc4e2c5e3db3aeeae193396a75bc4e3b11f7',
    vendor_agreement: '28757aca7ff1309b7c7bb6914b782c1950fb4d353c71ceb5961231f81e33b693',
  },
  // Account closure: role-independent entry, cash/live-work guards and honest holds.
  '2026-10-04': {
    terms: 'cb304527a513e65d4c40ab2589d9bd650d1873cab3755317ddd50dea8f62bedf',
    privacy: 'b78985eb02c41427eac10445d2935e92cbead3cb600d2e8796d19d28db8407d8',
    driver_agreement: '36543a0b037d488ff96076092c65a30939fa6adf14825bd80a35120a18097089',
    vendor_agreement: '8bbbb883fe61443878d3183f615bca68c78d787265954e7ddfb5bd823567d702',
  },
  // [OWNER RULING 8 Oct, NO "WALLET" · legal] The Privacy Policy's "wallet
  // credentials" (a payer's MMG sign-in) reads "mobile-money credentials". Only
  // that phrase changes; the shared last-updated date changes all four hashes.
  // The Terms' denial "offers no wallet or stored value" stays as written.
  '2026-10-11': {
    terms: '25897b1b30a4010dbee2134560af0d0c546fb973d4398208a05b7d12a3e2a572',
    privacy: 'ccfdfc5dcb57c3e9463d5030966d6dbfc29e1de19640000a78feb1d31f10273f',
    driver_agreement: 'c5c776fd4b4b2d3bdccf6139154be6c2f40bd2f6a16c70f3e36b88adc79c29ba',
    vendor_agreement: '50c3b5717806a15389a8c0416c2cf4c6d210e713f608edc24f17c1304e4fdae8',
  },
  // [OWNER RULING 8 Oct, NO "WALLET" (2) + (3)] The Mover and Business
  // Agreements' fee paragraph adds: at most four weeks paid ahead; a fee paid
  // ahead is used only for the weekly fee; unstarted weeks are refunded and
  // recorded before an account is deleted; money received above the limit is
  // returned. The date re-pins all four. (Pinned while unpublished: these are
  // the first words served under this version.)
  '2026-10-12': {
    terms: '160fd6666250987bbd4ad6390c0ad5f9956293ebb6fcc9cb02ca6960b59cce4d',
    privacy: 'f21df903fffd27d695aef64078fcae055ac4dcf1dc31110a9cc1dec0af5295ef',
    driver_agreement: '5976fc9c5508c29325449db48b7b821ac658a58775d12bf1b3703e9e7f00ff9d',
    vendor_agreement: '0bd3f6dc34d89b10a3fcad7bbd00e4332b722b993caa180176de47b80dfaca62',
  },
  // [OWNER #62 · 14 Oct, NO PAYING AHEAD] The Mover and Business Agreements'
  // fee paragraph: one week at a time (while a week runs the coming week may be
  // paid, and no further), money beyond that returned, a fee paid before its
  // week starts used only for that fee and refunded at closing if its week has
  // not started. Proven the only change: putting the 12 Oct sentence and date
  // back reproduces all four 2026-10-12 hashes exactly. The date re-pins all four.
  '2026-10-14': {
    terms: '82ec39e1ee46cab2196511b2520b7368581d67cf92cde55989589ea26a3346ee',
    privacy: '0d7b3a0c47dfa346e2683ae83d7212a29e56b7a8fe9377e7add841fe2192ebb6',
    driver_agreement: 'f959e105f3de8af19cbeab972144e6448a7f37700a46609bf61b13697343dce7',
    vendor_agreement: '7330d551da8398684b065ca70010821e77a425d1add14136e7cb93f9bf73431f',
  },
  // [OWNER #46/#50/#52 + service-job ruling · 14 Oct] Terms §7 cancellations:
  // no cancellation fee ever; a store order is free until the store accepts,
  // then the customer contacts the store; rides, parcels and bookings free
  // while unaccepted and for five minutes after acceptance (owner ruling
  // 14 Oct); a service job request free in the app until it is booked, then
  // the customer contacts the provider; an MMG Order whose payment the
  // Business confirmed is never cancelled in the app (the Business cancels and
  // refunds); no-mover and very-late exits. Proven the only change: putting the
  // 14 Oct paragraph and date back reproduces all four 2026-10-14 hashes
  // exactly. The date re-pins all four.
  '2026-10-15': {
    terms: '20757d114063d24da7d8f11cab48a0674ffe8b28ed0b4a151293853e86df2b41',
    privacy: '9b0bc20a6fef07772523483fa63d120bb915cb9c588214c519dfc506042ab2fe',
    driver_agreement: 'b148daa56ef00e9325cd364e90b7c5f19bc262ee260c557237bcd4d517c3b4d8',
    vendor_agreement: '89b9d5525e22546b9102b56421436bb7970e66ae63192bc5e31a5886de3e8c99',
  },
  // [V1b batch · owner 15 Oct 2026 · legal research Part 4] the operator named (reg. 17703, address, phone; one constant),
  // the research's Terms/Privacy/Mover/Business/Child Safety wording, letters or documents never carried, the 18+ box.
  '2026-10-16': {
    terms: 'f9edd1cd9c5d4818226af3cb3500d200b90b0205466a69a10be5ce6db0b2a5a9',
    privacy: '5abf3fc0bc88d5c2ea39df75b61384f6b3d3940c5c7d05081412a14388b729ed',
    driver_agreement: 'ec16841b718b6469eb4fcc980bf7a913c1ba32f6449580a87001a3cf9efaa35a',
    vendor_agreement: 'c3e89ace0ff86e0101462ed5df0a6805e7643b5330d550113b6a58fe081b30ae',
  },
  // [Owner rulings: identity checks by a person only + face matching off; customers take no photos (16 Oct);
  // R28] Privacy: no outside identity-verification company and no automated document-reading or face
  // matching (production refuses both), how partner documents and customer IDs are handled, partners-only
  // registration selfie, a customer is never shown by photo, "confirmation records"; Terms: the taxi
  // profile-photo sentence gone. The two agreements' words are unchanged: putting 16 October back
  // reproduces both 2026-10-16 agreement pins exactly. The date re-pins them.
  '2026-10-17': {
    terms: 'd738ef0158cb94f532552ca86ee5720f981503f799fc032f7f7bfdd810ecf96d',
    privacy: '4dfb9d4e5bff08df9a8f11a9c50a05255f8f2c650f757ad9fe99a220e1465c46',
    driver_agreement: 'fc950f5bafa0e6f108f2681dd31fb5b0e2d924d72cb47deca842abb3fb72dee0',
    vendor_agreement: '46876ae2bb41d822b5be2b631aa80c1d40070f036423de247703db1529aeb583',
  },
  // [#1614 leftover, COORD 17 Oct] Privacy s.6: a customer's own ID is kept while the account is open and
  // deleted when the account is deleted (it is not on the partner purge schedule). Nothing else changed:
  // putting 17 October back and removing that one sentence reproduces all four 2026-10-17 pins exactly.
  // The date re-pins Terms and the two agreements.
  '2026-10-18': {
    terms: '7cdf29225b5e5ab6378389ef5a40d805195ef1621fe250efac2b771aee17e65e',
    privacy: '45a9fa92f2e17c4599fd5e39c78c4551353fde75928a412e5372b3d68c118cdc',
    driver_agreement: '3d8a81a22b9e4d4606f62a63c3bd8e9636cc14763b313cbdfedcdece56cbd7cb',
    vendor_agreement: '5830eabd8bed0e94940765c26fe7f7b6920b52c601a9c45d26f0d084842484ed',
  },
  // [Owner rulings 21 Oct 2026 · research E4 + B8 · MATERIAL] Terms s.4: the taxi waiting charge paragraph
  // (GY$300 per full 10 minutes, as rides/taxi-waiting.ts applies it). Privacy: s.1 diagnostics line, s.5 the
  // phone app's crash reports to Swift's own GlitchTip, s.6 crash and error reports kept 90 days. Nothing else
  // changed: putting 18 October back and removing those words reproduces all four 2026-10-18 pins exactly.
  // The date re-pins the two agreements.
  '2026-10-21': {
    terms: 'a189ecbea42b30e2a7e116154073298a934c6f591a665b77d051f38d2236355c',
    privacy: '131bbf6e1c2e9b2f9a2b0062fc1a6e3bc126358e0e59885776cbb31da165ad08',
    driver_agreement: 'b368004247c5635c9ad085e93e92ce42db23f98b598b385e873b1619689e0fb8',
    vendor_agreement: 'd44c0a24a7ede15d0288aa2f4553cc6689c13ded8e95c6d6c2595ce2bce18185',
  },
  // [Owner ruling 22 Oct 2026 · NON-material pre-launch (COORD 23:14Z)] Terms s.7: a ride, a parcel or a booking
  // cancels free for one minute after a driver, rider or provider accepts it (was five minutes), as
  // order/cancel-policy.ts FREE_CANCEL_WINDOW_MIN applies it. Nothing else changed: putting "five minutes" and
  // 21 October back reproduces all four 2026-10-21 pins exactly. The date re-pins Privacy and the two agreements.
  '2026-10-22': {
    terms: '91d885a2cdf2e907d7017ee23f56fb0d14a1321b1128578e3be64efbde60bf7e',
    privacy: 'ebd6a47d17bdebd135068b1284d48893e1f3d306085e4c04a5e68a90afbe01da',
    driver_agreement: '77ba8953b63491aa88492edc5ec4fb815466a19c27ac6b5eea69a942102ed69b',
    vendor_agreement: 'bb12da4f86083b13050cafa99a2282ac7473c1b8c273d49da4c7dfac4d736910',
  },
  // [ROLE-DOCS · owner 21 Oct 2026 · COORD rulings (A) + 23 Oct 00:59Z, NON-material] On top of 2026-10-22: police
  // clearance optional for TAXI drivers only (Privacy "With your explicit consent" line; Mover Agreement documents
  // paragraph). Same day, so the human date is unchanged: Terms and the Business Agreement keep their 2026-10-22 hashes.
  '2026-10-22.1': {
    terms: '91d885a2cdf2e907d7017ee23f56fb0d14a1321b1128578e3be64efbde60bf7e',
    privacy: '9d0eb3b0e6b218d18edbb10630c4fcefeea090043cf5671c2b9ad7658f993ebb',
    driver_agreement: 'bfbfc55fb330b4d6e095ec3754c76570a8c128d460a7a59b3c4c0c586161b785',
    vendor_agreement: 'bb12da4f86083b13050cafa99a2282ac7473c1b8c273d49da4c7dfac4d736910',
  },
  // [Owner ruling 24 Oct 2026 ~05:55Z — NO CUSTOMER ID GATE · NON-material] Terms s.2: a customer needs no ID to place
  // an Order or take a taxi ride (the app asks for one only after repeated failed deliveries or payments, or for a
  // high-value promotion); Privacy s.2 "(partners and, where they add one, customers)" and s.3 the ID a customer adds;
  // Child Safety s.4 drops "higher-trust actions (taxi rides and larger orders) need a government ID on file".
  // Nothing else changed: putting those words and 22 October back reproduces all four 2026-10-22.1 pins exactly (and
  // Child Safety's served text). The date re-pins the two agreements.
  '2026-10-25': {
    terms: 'cace13357488b6dbc64dbfed520cbc0dbc13cd11472c073f817568d0695294ba',
    privacy: '7a2b01b3dbb2ffc0fd4bfbc384867d584ebeac56bc6c7b9e19a761e13dd8a9dc',
    driver_agreement: '4420cc613d36378213cb2fe6d62a3b27b5e32a98cd90e693d5d25125761b25ac',
    vendor_agreement: '43a48df497c99c20e5178262c37678de91076f5d1a331a2559374f2a85757ce1',
  },
};

describe('legal version binding [F-035-08]', () => {
  it.each([
    ['Mover Agreement', DRIVER_AGREEMENT],
    ['Business Agreement', VENDOR_AGREEMENT],
  ])('%s directs weekly-fee payment to checkout in the Swift app', (_name, agreement) => {
    expect(agreement).not.toMatch(/MMG\s+agent|Swift\s+Number|account\s+number/i);
    const feeParagraph = /<p>You pay Swift a flat weekly subscription[\s\S]*?<\/p>/.exec(agreement)?.[0];
    expect(feeParagraph).toContain("payable in the Swift app through MMG's checkout, or by card where the app offers it.");
  });

  it.each([
    ['Mover Agreement', DRIVER_AGREEMENT],
    ['Business Agreement', VENDOR_AGREEMENT],
  ])('%s states one week at a time (no paying ahead) and the refund of an unstarted week at closing [owner #62, 14 Oct]', (_name, agreement) => {
    const feeParagraph = /<p>You pay Swift a flat weekly subscription[\s\S]*?<\/p>/.exec(agreement)?.[0];
    expect(feeParagraph).toContain('You pay the weekly fee one week at a time: while a week runs you may pay for the coming week, and no further. Money received beyond that is returned to you.');
    expect(feeParagraph).toContain('If you close your account, Swift refunds to you any weekly fee you paid for a week that has not started, within 14 days, to the account you paid from, records the refund, and then deletes the account; a week that has started is not refunded.');
    expect(feeParagraph, 'the four-week limit is gone [owner #62]').not.toMatch(/four weeks|paid ahead|pay ahead/i);
  });

  it('the Terms name no cancellation fee — Swift never charges one [owner #46/#50/#52]', () => {
    expect(TERMS).toContain('<b>Swift never charges a cancellation fee.</b>');
    expect(TERMS).not.toMatch(/cancellation fee may apply|including any fee/i);
  });

  it('the Terms never promise an in-app cancel the app refuses [Opus review 14 Oct S3-1/S3-3]', () => {
    // An MMG Order whose payment the Business confirmed (CAPTURED/CLAIMED) is refused at every stage, even before acceptance.
    expect(TERMS).toContain('If you paid by MMG and the Business has already confirmed your payment, the app cannot cancel the Order at any stage, even before the Business accepts it: contact the Business to cancel it.');
    // The app offers a customer Cancel on a service job only while it is a request (REQUESTED/QUOTED), not once booked.
    expect(TERMS).toContain('A service job request can be cancelled free in the app until the job is booked; once it is booked, contact the provider to change or cancel it.');
    expect(TERMS).not.toMatch(/service job can be cancelled free until the provider starts/i);
  });

  it('[owner 22 Oct 2026] the Terms state the free cancel window the server applies: one minute after acceptance', () => {
    // FREE_CANCEL_WINDOW_MIN is the window cancellationVerdict enforces; the Terms must name that number, never another.
    expect(FREE_CANCEL_WINDOW_MIN).toBe(1);
    expect(TERMS).toContain('A ride, a parcel or a booking can be cancelled free at any time while nobody has accepted it, and for one minute after a driver, rider or provider accepts it; after that, contact your driver, rider or provider.');
    expect(TERMS).not.toMatch(/five minutes after a driver|5 minutes after a driver/i);
  });

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
    // [ROLE-DOCS · COORD ruling 21 Oct 2026 — a DELIBERATE extension] A second stamp on the same day carries a
    // same-day suffix (2026-10-22.1): versions compare as strings, so it sorts after 2026-10-22 and before the next
    // day. The date part still has to match LAST_UPDATED.
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    // The human form is rendered into both documents — same date, or the
    // page contradicts its own version.
    const [y, m, d] = LEGAL_VERSION.split('.')[0]!.split('-').map(Number);
    const human = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
    expect(TERMS, `TERMS should carry "Last updated: ${human}"`).toContain(human);
    expect(PRIVACY, `PRIVACY should carry "Last updated: ${human}"`).toContain(human);
  });
});
