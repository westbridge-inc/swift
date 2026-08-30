import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Public legal pages, served by the API so the mobile app has a stable home
// for them (linked from registration). Product-facing content, not internal
// docs. Plain HTML — no client JS, readable in any in-app browser.
// ---------------------------------------------------------------------------

/** Machine version of the served legal pack — stamped onto User.tosVersion at
 *  signup consent [SWIFT-AUD-D9-03]. Bump BOTH constants together whenever the
 *  Terms/Privacy content changes. */
// [REPORT-035 F-035-08 · S1] '2026-08-24' exists because #758 (2026-08-23)
// changed the Privacy account-deletion wording UNDER the '2026-08-16' stamp.
// The consent ledger is immutable per (documentType, version, locale): any
// long-lived database already holding the old 2026-08-16 row then threw a
// hash-mismatch on every consented registration — a 500 at signup. The old
// row is retained untouched (legal evidence is never rewritten); the changed
// words get their own version. legal-version-binding.test.ts now pins every
// served text to its version, so words can never change under a stamp again.
export const LEGAL_VERSION = '2026-08-30';
const LAST_UPDATED = '30 August 2026'; // human form of LEGAL_VERSION

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Swift</title>
<style>
  body{font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#fff;color:#1c1c1e;line-height:1.55}
  main{max-width:720px;margin:0 auto;padding:32px 20px 64px}
  h1{font-size:26px;margin:0 0 4px} .muted{color:#6e6e73;font-size:13px;margin-bottom:28px}
  h2{font-size:17px;margin:28px 0 8px} p,li{font-size:15px} ul{padding-left:20px}
  .brand{color:#E8192C;font-weight:700}
</style>
</head>
<body><main>
<p class="brand">Swift</p>
<h1>${title}</h1>
<p class="muted">Last updated: ${LAST_UPDATED}</p>
${body}
</main></body></html>`;
}

export const TERMS = page(
  'Terms of Service',
  `
<p>These Terms of Service ("<b>Terms</b>") are a binding agreement between you and Swift — the operator of the Swift mobile application, websites and related services (together, the "<b>Platform</b>") — for Guyana and the other Caribbean markets where Swift operates ("<b>Swift</b>", "we", "us"). Our full registered business name and address are available on request through the contact channel in section 21. By creating an account, ticking the acceptance box at registration, or using the Platform, you accept these Terms and our Privacy Policy. Under Guyana's electronic-transactions law, your electronic acceptance is as binding as a signature. If you do not agree, do not use the Platform.</p>

<h2>1. Definitions</h2>
<p>"<b>Business</b>" — an independent restaurant, supermarket, shop or service provider selling through the Platform. "<b>Mover</b>" — an independent delivery rider, courier or taxi driver offering transport through the Platform. "<b>Partner</b>" — a Business or a Mover. "<b>Order</b>" — a purchase, delivery, parcel, booking or ride you request through the Platform. "<b>Handover</b>" — the moment goods, a parcel or a completed service or ride is delivered to you.</p>

<h2>2. What Swift is — and is not</h2>
<p>Swift is a technology platform: it publishes Partners' listings, transmits Orders, matches deliveries and rides, and provides tracking, messaging and safety tools. Every Partner is an independent operator. Swift is <b>not</b> the seller of any goods, the provider of any ride, delivery or service, the employer, agent or joint venturer of any Partner, or a party to the contract formed between you and a Partner when an Order is accepted. Each Order is a direct contract between you and the relevant Business (for goods and services) and, for its carriage, the relevant Mover. Where these Terms limit Swift's responsibility, they never limit the responsibility a Partner owes you under the contract you form with them or under law.</p>

<h2>3. Eligibility and your account</h2>
<p>You must be at least 18 years old and capable of forming a binding contract. An account requires a phone number verified by SMS code; higher-value Orders and all taxi rides additionally require identity verification with a government-issued ID, requested in the app when it becomes necessary. You agree to give accurate information, keep it current, use one account, and keep your sign-in ability to yourself. You are responsible for activity under your account until you tell us it has been compromised. One person may hold customer and Partner roles on the same account; the Partner roles carry additional obligations presented at Partner onboarding.</p>

<h2>4. Payments are direct — Swift holds no money</h2>
<p>Swift is software, not a payment service. Orders are paid <b>in cash at Handover</b>, or — where a Partner offers it — directly into that Partner's own MMG mobile-money account, in MMG's own flow and under MMG's terms. Swift never holds, collects, processes or transmits Order money, offers no wallet or stored value, and never asks for card numbers. Prices shown in the app are the Business's own prices; delivery fees and fares are calculated estimates confirmed at the moment shown in the app. The only money Swift itself charges is the flat weekly subscription Partners pay for the software, and advertising fees under the separate advertising terms.</p>

<h2>5. Placing an Order</h2>
<p>Submitting an Order is an offer to the Business; the contract forms when the Business accepts it in the app. A Business may decline an Order and must tell you why through the app. If an item turns out to be unavailable, the app asks <b>you</b> to approve a substitution or that line is removed and, where you already paid by MMG, refunded by the Business — never swapped silently. Service bookings reserve the time slot shown; express delivery, where offered, buys priority handling.</p>

<h2>6. Paying at Handover</h2>
<p>Payment is due before or at Handover. Refusing to pay for what you ordered, or repeatedly failing to accept deliveries you requested, results in recorded strikes on your account and can restrict or end your access to cash-on-delivery or to the Platform.</p>

<h2>7. Cancellations and refunds</h2>
<p>You can cancel within the window the app shows for your Order. Cash Orders cancel free within that window. If you already sent an MMG payment to a Business, cancelling stops fulfilment and <b>the Business refunds you directly</b> on its own MMG — because Swift never holds the money, every refund of Order money is made by, and is the obligation of, the Partner who received it. After a Business has started acting on your Order a cancellation fee may apply; the exact outcome, including any fee, is computed by our servers at the moment you cancel and shown to you before you confirm. If something goes wrong with a fulfilled Order, report it from the Order screen: claims are reviewed with GPS and photo evidence under Swift's published guarantee process, and any settlement of Order money is made by the responsible Partner.</p>

<h2>8. Your conduct</h2>
<p>You agree not to: (a) break the law through the Platform or order anything unlawful; (b) harass, threaten, discriminate against or endanger Partners, customers or staff; (c) place Orders you do not intend to honour, or manipulate ratings, promotions, referrals or the strike system; (d) trigger safety features falsely; (e) impersonate anyone or use another person's account or documents; (f) interfere with the Platform — no scraping, automated access, probing, reverse engineering, or circumventing technical or fee protections; (g) use Platform data for any purpose outside your own use of Swift. We may investigate violations and act under section 17.</p>

<h2>9. Reviews, messages and other content</h2>
<p>You may post ratings, reviews, reports and order-scoped chat messages. You keep ownership of what you write, and you grant Swift a non-exclusive, royalty-free, worldwide licence to host, display, moderate and share it as needed to operate the Platform (for example, showing your review on a storefront, or your first name and rating to a matched Partner). Content must be truthful, lawful and respectful; you are responsible for what you post, including under defamation law. We may remove content that breaks these rules and act on reports — every review and message carries a report action, and blocking a person stops their messages and stops Swift matching you with them. Our Child Safety Standards page states our zero-tolerance rules and reporting channel for child-safety concerns.</p>

<h2>10. Safety features and their limits</h2>
<p>Taxi rides include an in-app PIN handshake so you meet the right driver, live trip sharing, and an SOS button that alerts our operations team and your verified emergency contacts with your live location. These tools support your safety; they are <b>not</b> a substitute for the emergency services, and Swift cannot guarantee an outcome from their use. Misusing them — including false alarms — ends your access and may be reported to the authorities.</p>

<h2>11. Partners</h2>
<p>Partners subscribe to Swift for a flat weekly fee and keep 100% of what they earn — Swift charges Partners no commission on Orders. Partners are independent: they decide when to be open or online, are responsible for their goods, services, vehicles, licences, insurance and tax affairs, and are verified through document checks before operating. Partner accounts are subject to the additional terms presented at onboarding, to quality and safety standards, and to suspension for expired documents, non-payment of the subscription, or misconduct. Nothing in the Platform creates employment between Swift and any Partner.</p>

<h2>12. Licence and intellectual property</h2>
<p>We grant you a personal, revocable, non-transferable licence to use the Swift app and websites for their intended purpose. The Platform, its software, design, and the Swift name and marks belong to Swift or its licensors; Partner content belongs to Partners. No rights are granted except as stated. If you send us feedback or suggestions, we may use them without obligation.</p>

<h2>13. Third-party services</h2>
<p>Parts of the experience depend on third parties — for example MMG for direct payments between you and Partners, mapping providers, and SMS carriers. Their services are governed by their own terms, and Swift is not responsible for their acts, omissions or availability.</p>

<h2>14. Availability and changes to the Platform</h2>
<p>The Platform is provided on an "as available" basis: we work to keep it running, but we do not promise uninterrupted or error-free operation, that any Partner will be open or nearby, or that any feature will remain unchanged. We may modify, suspend or discontinue features with reasonable notice where the change is material.</p>

<h2>15. Disclaimers</h2>
<p>To the maximum extent permitted by law, Swift disclaims all warranties about the Platform not expressly stated in these Terms. The quality, safety, legality and fitness of goods, services, deliveries and rides are the responsibility of the Partner who provides them, and your statutory guarantees in respect of them — including under Guyana's consumer-protection law — operate against that Partner and are <b>not</b> affected by these Terms. Nothing in these Terms excludes or limits any right or remedy the law does not allow to be excluded or limited.</p>

<h2>16. Limitation of liability</h2>
<p>To the maximum extent permitted by law: (a) Swift is not liable for the acts or omissions of Partners or other users, or for loss arising from the transaction between you and a Partner; (b) Swift is not liable for indirect or consequential loss, loss of profit, business, or data; and (c) Swift's total aggregate liability to you for claims arising from the Platform's own role is limited to the total amounts you paid to Swift (not to Partners) in the twelve months before the event giving rise to the claim. None of this excludes or limits liability for death or personal injury caused by Swift's own negligence, for fraud, or for anything else that cannot lawfully be excluded or limited.</p>

<h2>17. Suspension and termination</h2>
<p>You may stop using Swift at any time and may delete your account in the app (Profile &rarr; Personal data &rarr; Delete my account). We may suspend or terminate your access, with notice where practicable, for breach of these Terms, fraud, safety risk, legal requirement, or — for Partners — expired verification documents or subscription non-payment. Sections that by their nature should survive (including 9, 12, 15, 16, 18 and 19) survive termination, and records we are legally required to keep are retained as the Privacy Policy describes.</p>

<h2>18. Indemnity</h2>
<p>To the extent permitted by law, you agree to compensate Swift for losses, claims and reasonable costs arising from your breach of these Terms, your unlawful use of the Platform, or content you post — except to the extent caused by Swift's own breach or negligence.</p>

<h2>19. Governing law and disputes</h2>
<p>These Terms are governed by the laws of the Co-operative Republic of Guyana, and the courts of Guyana have jurisdiction over disputes arising from them. Please contact us first — most issues are resolved through Help &amp; Support, which creates a tracked ticket a human answers. Nothing in these Terms limits your right to complain to or seek relief from any authority the law provides, including Guyana's consumer-affairs authorities for consumer matters and the Data Protection Commissioner for personal-data matters.</p>

<h2>20. General</h2>
<p>These Terms, the Privacy Policy, and the policies and Partner or advertiser terms referenced in them are the entire agreement between you and Swift about the Platform. If any provision is found invalid, the rest remain in force. A failure to enforce a provision is not a waiver of it. You may not assign your rights under these Terms; Swift may assign to an affiliate or a successor to its business, and material corporate changes affecting your data are handled as the Privacy Policy describes. Swift is not responsible for delay or failure caused by events beyond its reasonable control. These Terms are concluded in English.</p>

<h2>21. Changes to these Terms</h2>
<p>We may update these Terms. Material changes are announced in the app before they take effect, and where the law requires fresh consent we will ask for it. Each version of these Terms is recorded with its date and an integrity hash, so the exact words you agreed to are always provable. Continued use after a change takes effect is acceptance of the updated Terms.</p>

<h2>22. Contact</h2>
<p>Questions and complaints: the in-app <b>Help &amp; Support</b> section is the fastest channel and creates a tracked ticket. Privacy matters: <b>privacy@swift.gy</b>. Our registered business name and postal address are available on request through either channel.</p>
`,
);

export const PRIVACY = page(
  'Privacy Policy',
  `
<p>This policy explains what personal data Swift collects, why, on what legal basis, who it is shared with, how long it is kept, and the rights you have — written to meet Guyana's Data Protection Act 2023. We collect the minimum needed to run a delivery, ride and marketplace platform, and <b>we never sell your data</b>.</p>

<h2>Who is responsible (data controller)</h2>
<p>Swift is the data controller for the personal data described here, operated in and from Guyana. Our full registered business name and postal address are available on request from the contact below. For anything about your privacy — access, correction, deletion or a complaint — email <b><a href="mailto:privacy@swift.gy">privacy@swift.gy</a></b>. This inbox reaches us even if you can no longer sign in to the app, so you are never locked out of your rights. This policy covers customers, Partners (businesses and movers), advertiser contacts, and visitors to our websites.</p>

<h2>1. What we collect</h2>
<ul>
<li><b>Account:</b> your phone number (verified by SMS code), name, and optional email.</li>
<li><b>A registration selfie</b> to deter account fraud; it becomes your in-app photo.</li>
<li><b>Orders, rides and bookings:</b> what you ordered, addresses you save or enter, delivery instructions, and the trip/delivery history tied to your account.</li>
<li><b>Location:</b> your device location while you use the app to set pickup/delivery points. For movers, live location while online — that is what powers dispatch and customer tracking. Background collection for movers happens only after a separate, explicit in-app consent, and stops when you go offline.</li>
<li><b>Verification documents (partners and, where required, customers):</b> government ID and, for movers, licence, insurance and related documents. These are stored privately; in the app they are viewable only by our verification team through short-lived signed links, each access logged. To confirm a document and selfie match, they are also processed by our identity-verification provider (see the provider list below).</li>
<li><b>Messages, ratings and reports:</b> order-scoped chat messages, the ratings and review tags you give and receive, reports you file, and your block list.</li>
<li><b>Emergency contacts:</b> if you add one, their name and phone number. We text them a verification code immediately, use the number only for your safety alerts, and never for marketing. If someone added you and you want the number removed, email <b>privacy@swift.gy</b>.</li>
<li><b>Support and consent records:</b> your Help &amp; Support tickets, and the consent ledger — a tamper-evident record of each policy version you agreed to, when, and on what surface. At consent we may also store a keyed cryptographic digest of your network address as evidence of the event; the address itself cannot be read back from it.</li>
<li><b>Device and diagnostics:</b> a push-notification token, app version, and crash/error reports.</li>
<li><b>Partner records (partners only):</b> subscription and payment-confirmation history for the weekly fee, earnings summaries, and operational quality metrics.</li>
</ul>

<h2>2. What we do NOT collect</h2>
<p>Swift never holds your order money, so we do not collect card numbers or wallet credentials. If you pay a business through MMG, that payment happens in MMG's own flow under MMG's terms — we only record that the business confirmed receiving it. Our websites and app carry no third-party advertising or cross-site tracking pixels.</p>

<h2>3. Why we use it — and the legal bases</h2>
<p>Under the Data Protection Act 2023, each use of your data rests on a legal basis:</p>
<ul>
<li><b>To perform our contract with you:</b> running your account; transmitting orders; matching deliveries and rides; live tracking; receipts; order-scoped chat; Partner subscription administration.</li>
<li><b>To meet legal obligations:</b> identity and document verification where required; keeping transaction, consent and audit records; responding to lawful demands.</li>
<li><b>For legitimate interests, balanced against your rights:</b> preventing fraud and abuse (strikes, collusion checks, GPS-plausibility and account-security signals), keeping the platform safe and available, and producing aggregated, de-identified statistics (e.g. orders per day) that carry no personal data. You may object — see section 9.</li>
<li><b>With your consent, separately asked and freely refusable:</b> marketing messages; background location for movers; the optional email on your profile. Consent can be withdrawn at any time without affecting the service.</li>
</ul>

<h2>4. Automated systems and human review</h2>
<p>Swift uses automated systems to match orders to movers, estimate times, and flag possible fraud or account-takeover risk. Flags lead to review, not to automatic punishment: no decision that produces a legal or similarly significant effect on you — losing your account, a penalty, a withheld payment confirmation — is taken by a machine alone; a human reviews the record first, and security holds (such as a staged change to where a Partner is paid) are announced to the account owner with a way to cancel them. You can contest any such decision through Help &amp; Support.</p>

<h2>5. Sharing</h2>
<p>A business sees what it needs to fulfil your order (items, first name, delivery address). A mover sees pickup/drop-off details and your first name. Movers and customers see each other's first names, photos and ratings. Your verified emergency contacts receive your live location if you raise an SOS. We share data with authorities only where the law requires it, and we document every such demand.</p>
<p><b>Technical service providers (processors):</b> to run Swift we use a small number of providers, each bound to process only what its function needs, on our instructions: Twilio (delivers your SMS verification codes — your phone number), Expo (delivers push notifications — a device token), an identity-verification provider — Didit or ID Analyzer — (receives the verification document and matching selfie to perform the identity check), Sentry (crash and error reports; we attach route templates rather than full URLs, drop request query strings, headers, cookies and bodies, and run an automated filter that reduces tokens and signed links across the report — a report is diagnostic context, not your account records), encrypted cloud object storage (verification documents and images), and Google Maps (addresses and coordinates for map display and travel estimates). Some of these providers process data on infrastructure outside Guyana; where that happens, the transfer is made under the Act's conditions with contractual safeguards and the minimisation described here.</p>
<p><b>AI processing:</b> some features — such as understanding a search query or tidying a store's menu text — use Anthropic's Claude API. Before any text is sent it passes an automated filter that removes phone numbers, email addresses, card-like numbers, tokens, document references and common address forms. Swift never sends your verification documents or account records to AI services, and these API inputs are not used to train AI models. Free text you type could still contain personal details the filter cannot recognise — avoid putting personal information in search terms or menu text.</p>
<p><b>Business changes:</b> if Swift's business is transferred to a successor, your data moves with it under this policy's protections, and you are told before any materially different use begins.</p>

<h2>6. Retention and deletion</h2>
<p>We keep personal data only as long as its purpose or a legal duty requires. Verification documents are purged on a schedule after they stop being needed, with the purge itself logged; purged documents are irrecoverable. Order, ride and settlement history is retained for the period required for disputes, guarantees, tax and legal obligations, and order-scoped chat is retained with its order's record. The consent ledger is retained as legal evidence of what was agreed — it is append-only by design and is kept even after account deletion, holding only what it must. You can delete your account from inside the app — <b>Profile &rarr; Personal data &rarr; Delete my account</b> — which permanently destroys your documents, revokes every signed-in session, and deletes or de-identifies personal data not subject to a legal retention duty. Business, driver and advertiser accounts are closed through Help &amp; Support instead, so outstanding listings and settlement records are handled correctly first.</p>

<h2>7. Security</h2>
<p>Data in transit is encrypted (the app pins Swift's certificates), access to production data is restricted and audit-logged, verification documents are encrypted at rest and readable only through short-lived signed links, security-sensitive account changes require step-up confirmation, and administrative actions on your account leave a permanent trail. No system is perfectly secure; if a breach creates a risk to you, we will notify the Data Protection Commissioner and affected users as the Act requires.</p>

<h2>8. Children</h2>
<p>Swift is for adults: you must be 18 to hold an account, and we do not knowingly process children's data. Our published Child Safety Standards state our zero-tolerance rules and the dedicated reporting channel; anything reported there is prioritised, removed, and reported to the authorities as the law requires.</p>

<h2>9. Your rights under the Data Protection Act 2023</h2>
<p>You have the right to: <b>access</b> the personal data we hold about you; have it <b>corrected</b>; request its <b>deletion</b>; <b>restrict</b> processing; <b>object</b> to processing based on legitimate interests and to any direct marketing; <b>withdraw a consent</b> at any time; receive a copy of your data in a <b>portable</b> form (the app's "Download my data" does this instantly); and <b>not be subject to a solely automated decision</b> with legal or similarly significant effect — section 4 describes how we already work that way. Exercise any of these by email to <b><a href="mailto:privacy@swift.gy">privacy@swift.gy</a></b> or through Help &amp; Support; we respond within the timeframes the Act sets, and identity is verified before data is released. Each right is subject to the legal retention duties described above, and exercising them never costs you the service. If you believe we have mishandled your data, you have the right to complain to the Data Protection Commissioner of Guyana.</p>

<h2>10. Changes to this policy</h2>
<p>Material changes are announced in the app before they take effect, and where the law requires fresh consent we ask for it. Every version of this policy is recorded with its date and an integrity hash, so the exact words that applied to you at any time are provable.</p>
`,
);

// STORE-003: published Child Safety Standards (store-compliance §5.4). Google
// Play requires apps with user-generated content to publish a child-safety
// standards page, provide an in-app way to report CSAE, and name a point of
// contact. This page states the standard and links it to the STORE-001 report
// mechanism (in-app report → CSAE) and a dedicated contact.
/** [DCR-1 NR1-03] Marketing is a PURPOSE consent — never bundled into the
 *  terms. This is the exact text a grant anchors to in the consent ledger. */
export const MARKETING_CONSENT = page(
  'Marketing Messages',
  `
<p>If you say yes, Swift may send you offers, promotions, and news about Swift services by push notification, SMS, or email. This is optional — saying no never affects your orders, rides, deliveries, or account.</p>

<h2>What you are agreeing to</h2>
<p>We may use your name, your order history, and your app activity to choose which offers we show you. We never sell your personal information, and we never share it with advertisers to market to you off Swift.</p>

<h2>Changing your mind</h2>
<p>You can withdraw this consent at any time in the app under Account → Marketing messages, and marketing stops. Service messages about your active orders (receipts, delivery updates, safety notices) are not marketing and continue either way.</p>
`,
);

// Exported: the web site's legal:sync snapshots this page too.
export const CHILD_SAFETY = page(
  'Child Safety Standards',
  `
<p>Swift has zero tolerance for child sexual abuse and exploitation (CSAE). This page sets out the standards we hold every account to, and how anyone can report a concern.</p>

<h2>1. What is prohibited</h2>
<p>It is strictly forbidden to use Swift to create, share, request, or promote any content or conduct that sexually abuses, exploits, or endangers a child. This includes child sexual abuse material (CSAM), grooming, sextortion, trafficking, and any sexualisation of a minor — in ratings, chat messages, profiles, images, listings, or any other surface. There is no exception.</p>

<h2>2. How to report</h2>
<p>Any user can report content or a person directly in the app: use the <b>Report</b> action on a review, chat message, profile or listing and select the <b>Child safety (CSAE)</b> reason. Reports reach our moderation team immediately and are prioritised. You can also email our child-safety point of contact at <b><a href="mailto:childsafety@swift.gy">childsafety@swift.gy</a></b>.</p>

<h2>3. How we respond</h2>
<p>CSAE reports are triaged ahead of all other moderation. Confirmed material is removed, the account is banned, and we report to the relevant authorities and, where applicable, to recognised child-protection bodies such as the National Center for Missing &amp; Exploited Children (NCMEC), as the law requires. We preserve evidence needed for those reports.</p>

<h2>4. Prevention</h2>
<p>Every account is phone-verified, higher-trust actions require government-ID verification, and a live registration selfie deters fake accounts. Reports feed an account risk system that restricts and removes abusers.</p>

<h2>5. Point of contact</h2>
<p>For child-safety matters, including law-enforcement and child-protection enquiries: <b><a href="mailto:childsafety@swift.gy">childsafety@swift.gy</a></b>.</p>
`,
);

export async function legalRoutes(app: FastifyInstance) {
  app.get('/terms', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return TERMS;
  });
  app.get('/privacy', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return PRIVACY;
  });
  app.get('/marketing', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return MARKETING_CONSENT;
  });
  app.get('/child-safety', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return CHILD_SAFETY;
  });
}
