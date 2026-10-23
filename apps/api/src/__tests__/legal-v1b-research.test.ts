import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMS, PRIVACY, DRIVER_AGREEMENT, VENDOR_AGREEMENT, MARKETING_CONSENT, CHILD_SAFETY, LEGAL_VERSION } from '../modules/legal/legal.routes';
import { OPERATOR, OPERATOR_ADDRESS } from '../modules/legal/operator';

// ---------------------------------------------------------------------------
// [V1b legal batch · LEGAL_VERSION 2026-10-16 · owner 15 Oct 2026] The owner's legal research (Part 4,
// "Document review and replacement wording") applied as written, blanks filled with the owner's facts:
// Westbridge Inc., registration no. 17703, its registered address and phone, the data protection officer
// by role. Each sentence is pinned here exactly, so a later edit cannot quietly drop one. A sentence that
// describes a feature was checked against the code before it was published (see the PR).
// Still a DRAFT the owner and counsel review (GUARDRAILS §2).
// ---------------------------------------------------------------------------

const ID = 'Westbridge Inc., a company registered in Guyana (registration no. 17703) trading as Swift, of Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana';
const para = (doc: string, startsWith: string) => {
  const m = new RegExp(`<(?:p|li)>(?:<b>)?${startsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?</(?:p|li)>`).exec(doc);
  if (!m) throw new Error(`no paragraph starting "${startsWith}"`);
  return m[0];
};

describe('the operator, from one constant', () => {
  it('holds the owner-given facts', () => {
    expect(OPERATOR).toMatchObject({
      name: 'Westbridge Inc.', tradingAs: 'Swift', registeredIn: 'Guyana', registrationNo: '17703',
      registeredAddress: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara',
      phone: '+592 716 3534', supportEmail: 'support@swiftgy.com', privacyEmail: 'privacy@swiftgy.com',
      dpoRole: 'Data Protection Officer, Westbridge Inc.',
    });
    expect(OPERATOR_ADDRESS).toBe('Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana');
  });

  it('nothing is "available on request", and the name and address are written in exactly one API source file', () => {
    for (const doc of [TERMS, PRIVACY, DRIVER_AGREEMENT, VENDOR_AGREEMENT, MARKETING_CONSENT, CHILD_SAFETY]) expect(doc).not.toMatch(/available on request/i);
    const src = join(process.cwd(), 'src');
    const files = (function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(p, out); }
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
      }
      return out;
    })(src);
    const holders = files.filter((f) => /Lot 165|New Trafalgar|Westbridge Inc|17703|716 3534/.test(readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')));
    expect(holders.map((f) => relative(src, f))).toEqual([join('modules', 'legal', 'operator.ts')]);
  });
});

describe('Terms of Service (Part 4)', () => {
  it.each([
    ['¶1 who the agreement is with, Guyana only, the tick, binding', `<p>These Terms of Service are a binding agreement between you and ${ID} ("<b>Swift</b>", "we", "us"), which operates the Swift app, websites and related services in Guyana (the "<b>Platform</b>"). By creating an account and ticking the acceptance box, you accept these Terms and confirm you have read our Privacy Policy. Your electronic acceptance forms a binding contract. If you do not agree, do not use the Platform.</p>`],
    ['¶4 P5 ID wording + the 18+ box', 'You must be at least 18 years old and capable of forming a binding contract. By creating an account you confirm that you are 18 or older; where the sign-up shows the "I am 18 or older" box, you confirm it by ticking that box. An account requires a phone number verified by SMS code; higher-value Orders and all taxi rides additionally require a government-issued ID on file, requested in the app when it becomes necessary. A customer never needs a photo.'], // [owner 16 Oct: customers take no photos; 2026-10-17]
    ['¶5 payments and prices', "<p>Swift is software, not a payment service. You pay for an Order in cash at Handover or, where the Business offers it, directly into the Business's own MMG account under MMG's terms. Swift never holds, collects or transmits Order money, offers no wallet or stored value, and never asks for card numbers. Prices are the Business's own prices. Delivery fees and taxi fares are calculated by Swift and shown in the app before you confirm. Swift charges customers nothing.</p>"],
    ['¶8 problems + statutory rights', "If something goes wrong with a fulfilled Order, report it from the Order screen within 7 days. Swift reviews it with GPS and photo evidence and asks the Business to put it right; any refund of Order money is made by the Business that received it. Nothing in this section affects your rights under the Consumer Affairs Act 2011, including returning goods to, and getting refunds from, the Business.</p>"],
    ['¶9 (h) the prohibited list, letters or documents, legal services', '(h) order, sell, send or carry anything Swift prohibits: alcohol, tobacco and vapes, medicines and drugs, 18+ items, cooking gas and fuel, weapons and ammunition, fireworks and explosives, pesticides and controlled chemicals, protected wildlife, raw gold and precious minerals, lottery and gambling products, counterfeit goods, currency and payment cards, and letters or documents; or offer legal services.'],
    ['¶11 SOS is not an emergency service', "These tools support your safety. Swift's safety team is not an emergency service and may not respond immediately; in an emergency call Police 911, Fire 912 or Ambulance 913 first."],
    ['§14 updates', 'The app may update itself to fix problems or improve features.</p>'],
    ['¶17(c) liability floor', "(c) Swift's total liability to you for claims arising from the Platform's own role is limited to the greater of the amounts you paid Swift in the twelve months before the event and GYD 100,000."],
    ['¶19 indemnity', "<p>To the extent the law allows, you agree to compensate Swift for reasonable losses and costs caused by your fraud, your deliberate breach of these Terms, or unlawful content you post, except to the extent caused by Swift's own breach or negligence.</p>"],
    ['¶20 authorities', 'including the Competition and Consumer Affairs Commission for consumer matters and, once the Data Protection Act is in force, the Data Protection Commissioner.</p>'],
    ['¶22 changes', '<p>We announce material changes in the app at least 14 days before they take effect and ask you to accept them in the app. If you do not accept, you can stop using Swift and delete your account.</p>'],
    ['¶23 contact', '<p>Westbridge Inc. (trading as Swift), registration no. 17703, Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana. Phone +592 716 3534. Email support@swiftgy.com; privacy matters privacy@swiftgy.com. The in-app <b>Help &amp; Support</b> section is the fastest channel.</p>'],
  ])('%s', (_name, text) => {
    expect(TERMS).toContain(text);
  });

  it('no longer says what the research removed', () => {
    for (const gone of [/Caribbean markets/, /calculated estimates/, /advertising terms/, /published guarantee process/, /Continued use after a change takes effect is acceptance/, /a document may travel/]) expect(TERMS).not.toMatch(gone);
    // [REVIEW-F S2-1 on #1753] held: the ride queue and pre-lock apps can book at a changed price, and no page publishes the formula
    expect(TERMS).not.toMatch(/nothing is booked|published formula/);
  });
});

describe('Privacy Policy (Part 4)', () => {
  it.each([
    ['¶1 the Act is passed, not in force; Swift follows it now', "and the rights you have. Guyana's Data Protection Act 2023 has been passed but, as of 22 October 2026, has not been brought into force. Swift follows it now and will update this policy when it starts."],
    ['¶2 controller and data protection officer', '<p>Westbridge Inc. (trading as Swift), registration no. 17703, Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana, is the data controller. Our data protection officer is the Data Protection Officer, Westbridge Inc., privacy@swiftgy.com.'],
    ['¶15 ID checks for safety and fraud prevention', "checking partners' identity and licence documents, and customers' IDs for taxi rides and larger orders, for safety and fraud prevention.</li>"],
    ['¶16 legal obligations', '<li><b>To meet legal obligations:</b> keeping tax and accounting records, and responding to lawful demands from authorities.</li>'],
    ['¶18 police clearances', '<li><b>With your explicit consent:</b> police clearance certificates (optional for drivers and riders; required for service providers who visit homes).</li>'],
    ['¶21 MapTiler cookies (B6)', "MapTiler's own servers may set cookies; Swift does not."],
    ['¶21 where the servers are', "Our servers are with DigitalOcean in Atlanta, United States, and several providers process data in the United States. We use each provider's written data-protection terms and send only what each needs.</p>"],
    ['¶21 Cloudflare, WhatsApp, MMG, Google Places named', 'Cloudflare (runs the domain-name service (DNS)'],
    ['¶25 breach', 'If a breach is likely to put you at risk, we will tell you without undue delay and, once the Data Protection Act is in force, notify the Data Protection Commissioner within 72 hours.</p>'],
    ['¶27 response time', 'within one month (up to two more months for complex requests, and we will tell you why)'],
    ['§9 heading', '<h2>9. Your rights under, and before the start of, the Data Protection Act 2023</h2>'],
    ['C7/C8 a rider holding a customer\'s cash; the customer is never blocked', "If a rider still holds a customer's cash from an order, the rider's account deletion waits until our operations team records it resolved, or for at most 90 days; the cash record is kept as part of the order record. A customer's own deletion is never blocked by this. If we cannot act on a deletion request straight away, we tell you why and when, in writing, within one month."],
  ])('%s', (_name, text) => {
    expect(PRIVACY).toContain(text);
  });

  it('the processors paragraph names each provider the research lists', () => {
    const processors = para(PRIVACY, 'Technical service providers (processors):');
    for (const name of ['DigitalOcean', 'Cloudflare', 'Twilio', 'Expo', 'GoDaddy', 'MMG', 'WhatsApp', 'Meta', 'Google Places', 'MapTiler', 'OpenStreetMap']) expect(processors).toContain(name);
    expect(processors).not.toMatch(/Sentry/);
  });

  it('no longer says what the research removed', () => {
    for (const gone of [/written to meet Guyana's Data Protection Act 2023/, /within the timeframes the Act sets/, /available on request/]) expect(PRIVACY).not.toMatch(gone);
  });
});

describe('Mover and Business Agreements (Part 4)', () => {
  const F2 = 'Swift may change the weekly fee. We will tell you in the app at least 14 days before the change. The new fee applies from your first weekly fee due after that date. If you do not accept it, stop your plan before then; you will not pay the new fee.';
  it.each([['Mover', DRIVER_AGREEMENT], ['Business', VENDOR_AGREEMENT]])('%s: the seller, the F2 price-change clause, refund timing, the 48-hour grace and reversals', (_n, doc) => {
    expect(doc).toContain(`<p>The weekly subscription is sold by Swift's operator, Westbridge Inc. (registration no. 17703), ${OPERATOR_ADDRESS}.</p>`);
    expect(doc).toContain(F2);
    expect(doc).toContain('Swift refunds to you any weekly fee you paid for a week that has not started, within 14 days, to the account you paid from,');
    expect(doc).toContain('If the weekly fee is still unpaid 48 hours after it falls due,');
    expect(doc).toContain('If you pay twice or pay too much, Swift may return the whole payment through MMG instead of a manual refund');
    expect(doc).not.toMatch(/settlement records|settle any amounts|ledger both sides/);
  });

  it('Mover: P1 documents, the selfie, courier goods only, confirmation records, insurance and hire licences', () => {
    expect(DRIVER_AGREEMENT).toContain("(for example: your driver's licence — or, if you ride a bicycle, your national ID or Digital ID card — vehicle registration, and insurance appropriate to carrying passengers where you drive passengers). A police clearance is optional: if you upload one and Swift approves it, your account is recorded as police-cleared; it is never needed to go online.");
    expect(DRIVER_AGREEMENT).toContain('You may not let anyone else work under your account; Swift may ask for a selfie, reviewed by a person, to confirm it is you.');
    expect(DRIVER_AGREEMENT).toContain('on courier jobs, carrying goods only — never letters, documents or mail, which in Guyana only the Post Office may carry;');
    expect(DRIVER_AGREEMENT).toContain("The app's confirmation records show what each side has confirmed; Swift does not hold or move this money.");
    expect(DRIVER_AGREEMENT).toContain("Taxi drivers must hold insurance covering passengers carried for hire. Anyone delivering must hold insurance that permits use for hire or reward. Taxi drivers must hold a current hire-car driver's licence, and the car a current hire-car licence.");
    expect(DRIVER_AGREEMENT).not.toMatch(/in-shift selfie|police clearance\)|profile shows that you are police-cleared/);
    // [R25 · owner 15 Oct · research D13] independence; declining or handing back never costs anything
    expect(DRIVER_AGREEMENT).toContain('You may work with other apps, platforms or customers at the same time; Swift never asks for exclusivity. Swift sets no uniform and no working hours: you choose when, where and how long you work.');
    expect(DRIVER_AGREEMENT).toContain('You may decline any offer, and hand a job back before pickup: declining or handing back never costs you a strike, a lower place in the offer order, or any other penalty. Strikes are only for safety, fraud or dishonesty, for example fake completions, GPS manipulation or collusion detected by our integrity systems, and can lead to restriction or removal.');
    expect(DRIVER_AGREEMENT).not.toMatch(/cherry-picking|repeated abandonment/);
  });

  it('Business: authority, P1 documents + January renewal, storefront facts + statutory rights, F8, own deliveries, invited staff', () => {
    expect(VENDOR_AGREEMENT).toContain('You confirm you are authorised to accept this Agreement for the business.');
    expect(VENDOR_AGREEMENT).toContain("(for example: the owner's national ID or Digital ID card, business registration, and the food-safety licences and permits your category requires). If you trade under a registered business name, renew it each January.");
    expect(VENDOR_AGREEMENT).toContain("<p>Your storefront must show your legal name, business address and phone. You must honour customers' return and refund rights under the Consumer Affairs Act 2011.</p>");
    expect(VENDOR_AGREEMENT).toContain('If you do not refund within 72 hours after Swift contacts you, Swift may suspend new orders or turn off MMG payment for your store until the refund is made.');
    expect(VENDOR_AGREEMENT).toContain('or, for any order you choose to deliver yourself, by your own staff, for whom you are fully responsible.');
    expect(VENDOR_AGREEMENT).toContain('You confirm each person you invite has agreed to be added.');
    expect(VENDOR_AGREEMENT).not.toMatch(/TIN certificate|if you enable self-delivery/);
  });
});

describe('held until the code does it (a sentence that describes a feature must match the code)', () => {
  it('Terms ¶7 full-payment rule, the Privacy chat-check sentence, the marketing STOP line and the retention list are not published yet', () => {
    expect(TERMS).not.toMatch(/the rider hands your cash back/);
    expect(PRIVACY).not.toMatch(/checked automatically for phone numbers/);
    expect(MARKETING_CONSENT).not.toMatch(/reply STOP/);
    expect(PRIVACY).not.toMatch(/deleted 30 days after our review decision/);
  });

  // [2026-10-17] P2 is published: identity checks by people, no outside identity-verification provider.
  it('P2 (human-only identity checks) is published: no Didit or ID Analyzer, no face-matching provider', () => {
    expect(PRIVACY).not.toMatch(/Didit|ID Analyzer/);
    expect(PRIVACY).toContain('Identity verification is done by our verification team: Swift uses no automated document-reading or face-matching service, and no identity-verification provider receives your documents or selfie.');
  });
});

describe('Child Safety (Part 4)', () => {

  it('Child Safety: report + email until every live app has the reason; the authorities named; P5', () => {
    expect(CHILD_SAFETY).toContain('use the <b>Report</b> action and email <b>childsafety@swiftgy.com</b>.');
    expect(CHILD_SAFETY).toContain('we report to the Guyana Police Force and the Childcare and Protection Agency and,');
    expect(CHILD_SAFETY).toContain('<p>Every account is phone-verified, higher-trust actions (taxi rides and larger orders) need a government ID on file, which our team can withdraw at any time, and partners\' profile photos deter fake partner accounts.'); // [owner 16 Oct: customers take no photos]
    expect(CHILD_SAFETY).not.toMatch(/live registration selfie|the relevant authorities/);
  });
});

describe('one version for the whole batch', () => {
  // The V1b batch shipped as 2026-10-16; the human-only identity + no-customer-photo words follow as 2026-10-17;
  // the customer-ID retention sentence (Privacy s.6) as 2026-10-18; the taxi waiting charge (Terms s.4) and phone
  // crash reports kept 90 days (Privacy) as 2026-10-21 (legal-waiting-crash-2026-10-21.test.ts); the one-minute
  // cancel window (Terms s.7, owner 22 Oct) as 2026-10-22 (legal-version-binding.test.ts).
  it('is 2026-10-22', () => {
    expect(LEGAL_VERSION).toBe('2026-10-22');
  });
});
