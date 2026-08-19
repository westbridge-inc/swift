import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Public legal pages, served by the API so the mobile app has a stable home
// for them (linked from registration). Product-facing content, not internal
// docs. Plain HTML — no client JS, readable in any in-app browser.
// ---------------------------------------------------------------------------

/** Machine version of the served legal pack — stamped onto User.tosVersion at
 *  signup consent [SWIFT-AUD-D9-03]. Bump BOTH constants together whenever the
 *  Terms/Privacy content changes. */
export const LEGAL_VERSION = '2026-08-16'; // [REPORT-016 F-016-02] Sentry disclosure matched to the deep recursive scrubber (route templates, dropped query/headers/cookies/body, whole-event token/link reduction)
const LAST_UPDATED = '16 August 2026'; // human form of LEGAL_VERSION

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
<p>These terms govern your use of the Swift app and platform, operated in Guyana and other Caribbean markets ("Swift", "we"). By creating an account or using Swift you agree to them.</p>

<h2>1. What Swift is</h2>
<p>Swift is a marketplace that connects customers with independent local businesses (restaurants, supermarkets, shops, service providers) and independent movers (delivery riders, couriers and taxi drivers). The businesses and movers on Swift are independent — Swift is not the seller of the goods, the employer of the movers, or a party to the transaction between you and them.</p>

<h2>2. Payments are direct — Swift holds no money</h2>
<p>Orders are paid in cash at handover, or directly to the business or driver through their own MMG account where they offer it. Swift never holds, processes or transmits your order money. Amounts shown in the app are quoted by the business or calculated fare estimates.</p>

<h2>3. Paying before handover</h2>
<p>Payment is due before or at handover. Refusing to pay for goods you ordered, or repeatedly failing to accept deliveries, leads to strikes on your account and can restrict or end your access to cash-on-delivery or to Swift entirely.</p>

<h2>4. Cancellations</h2>
<p>You can cancel within the window shown in the app for your order. Cash orders cancel free of charge inside that window. If you have already sent an MMG payment to a business for the order, cancelling stops fulfilment and the business refunds you directly on its own MMG — Swift never holds the money. After a business has started acting on your order, a cancellation fee may apply — the exact outcome, including any fee, is confirmed by our servers at the moment you cancel and shown to you immediately.</p>

<h2>5. Account requirements</h2>
<p>You need a verified phone number to use Swift. Higher-value orders and all taxi rides require identity verification (a government ID), shown in the app as it becomes required. You must be at least 18 to place orders.</p>

<h2>6. Movers and businesses</h2>
<p>Partners (businesses and movers) pay Swift a flat weekly subscription and keep 100% of what they earn. Partner accounts are subject to document verification, quality standards, and suspension for non-payment or misconduct.</p>

<h2>7. Safety</h2>
<p>Taxi rides include an in-app PIN handshake, trip sharing and an SOS button. Misusing safety features, harassing partners or customers, or fraudulent activity ends your access to Swift and may be reported to the authorities.</p>

<h2>8. Liability</h2>
<p>Swift provides the platform "as is". To the maximum extent permitted by law, Swift's liability for any claim arising from a transaction is limited to the platform's role in arranging it. Statutory consumer rights under Guyanese law are not affected.</p>

<h2>9. Changes</h2>
<p>We may update these terms; material changes are announced in the app. Continued use after a change is acceptance of the updated terms.</p>

<h2>10. Contact</h2>
<p>Questions and complaints: the in-app Help &amp; Support section is the fastest channel and creates a tracked ticket.</p>
`,
);

export const PRIVACY = page(
  'Privacy Policy',
  `
<p>This policy explains what Swift collects, why, and what control you have. We collect the minimum needed to run a delivery, ride and marketplace platform — and we never sell your data.</p>

<h2>Who is responsible (data controller)</h2>
<p>Swift is the data controller for the personal data described here, operated in and from Guyana. Our full registered business name and postal address are available on request from the contact below. For anything about your privacy — access, correction, deletion or a complaint — email <b><a href="mailto:privacy@swift.gy">privacy@swift.gy</a></b>. This inbox reaches us even if you can no longer sign in to the app, so you are never locked out of your rights.</p>

<h2>1. What we collect</h2>
<ul>
<li><b>Account:</b> your phone number (verified by SMS code), name, and optional email.</li>
<li><b>Orders and rides:</b> what you ordered, addresses you save or enter, and the trip/delivery history tied to your account.</li>
<li><b>Location:</b> your device location while you use the app to set pickup/delivery points. For movers, live location while online — that is what powers dispatch and customer tracking.</li>
<li><b>Verification documents (partners and, where required, customers):</b> government ID and, for movers, licence, insurance and related documents. These are stored privately; in the app they are viewable only by our verification team through short-lived signed links, each access logged. To confirm a document and selfie match, they are also processed by our identity-verification provider (see the provider list below).</li>
<li><b>A registration selfie</b> to deter account fraud; it becomes your in-app photo.</li>
</ul>

<h2>2. What we do NOT collect</h2>
<p>Swift never holds your order money, so we do not collect card numbers or wallet credentials. If you pay a business through MMG, that payment happens in MMG's own flow under MMG's terms — we only record that the business confirmed receiving it.</p>

<h2>3. How data is used</h2>
<p>To run the service: matching orders to movers, live tracking, receipts, safety features (trip sharing, SOS with live coordinates), fraud and abuse prevention (strikes, collusion checks), and legally required record-keeping. Aggregated, de-identified statistics (e.g. orders per day) carry no personal data.</p>

<h2>4. Sharing</h2>
<p>A business sees what it needs to fulfil your order (items, first name, delivery address). A mover sees pickup/drop-off details and your first name. Movers and customers see each other's ratings. We share data with authorities only where the law requires it.</p>
<p><b>Technical service providers:</b> to run Swift we use a small number of providers, each receiving only what its function needs: Twilio (delivers your SMS verification codes — your phone number), Expo (delivers push notifications — a device token), an identity-verification provider — Didit or ID Analyzer — (receives the verification document and matching selfie to perform the identity check), Sentry (crash and error reports; we attach route templates rather than full URLs, drop request query strings, headers, cookies and bodies, and run an automated filter that reduces tokens and signed links across the report — a report is diagnostic context, not your account records), encrypted cloud object storage (verification documents and images), and Google Maps (addresses and coordinates for map display and travel estimates).</p>
<p><b>AI processing:</b> some features — such as understanding a search query or tidying a store's menu text — use Anthropic's Claude API. Before any text is sent it passes an automated filter that removes phone numbers, email addresses, card-like numbers, tokens, document references and common address forms. Swift never sends your verification documents or account records to AI services, and these API inputs are not used to train AI models. Free text you type could still contain personal details the filter cannot recognise — avoid putting personal information in search terms or menu text.</p>

<h2>5. Retention and deletion</h2>
<p>Verification documents are purged on a schedule after they stop being needed, with the purge itself logged. Order history is retained for the period required for disputes, guarantees and legal obligations. You can request account deletion in Help &amp; Support; we delete or de-identify personal data not subject to a legal retention duty.</p>

<h2>6. Security</h2>
<p>Data in transit is encrypted (the app pins Swift's certificates), access to production data is restricted and audit-logged, and administrative actions on your account leave a permanent trail.</p>

<h2>7. Your rights under the Data Protection Act 2023</h2>
<p>Guyana's Data Protection Act 2023 gives you the right to access the personal data we hold about you, to have it corrected, to request its deletion or a restriction on how we process it, to object to processing, and to receive a copy of your data in a portable form — each subject to the legal retention duties described above. To exercise any of these, email <b><a href="mailto:privacy@swift.gy">privacy@swift.gy</a></b> or use Help &amp; Support in the app. If you believe we have mishandled your data, you also have the right to complain to Guyana's data-protection supervisory authority.</p>

<h2>8. Changes</h2>
<p>Material changes to this policy are announced in the app before they take effect.</p>
`,
);

// STORE-003: published Child Safety Standards (store-compliance §5.4). Google
// Play requires apps with user-generated content to publish a child-safety
// standards page, provide an in-app way to report CSAE, and name a point of
// contact. This page states the standard and links it to the STORE-001 report
// mechanism (in-app report → CSAE) and a dedicated contact.
const CHILD_SAFETY = page(
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
  app.get('/child-safety', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return CHILD_SAFETY;
  });
}
