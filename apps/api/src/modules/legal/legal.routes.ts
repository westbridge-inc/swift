import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Public legal pages, served by the API so the mobile app has a stable home
// for them (linked from registration). Product-facing content, not internal
// docs. Plain HTML — no client JS, readable in any in-app browser.
// ---------------------------------------------------------------------------

/** Machine version of the served legal pack — stamped onto User.tosVersion at
 *  signup consent [SWIFT-AUD-D9-03]. Bump BOTH constants together whenever the
 *  Terms/Privacy content changes. */
export const LEGAL_VERSION = '2026-07-15';
const LAST_UPDATED = '15 July 2026'; // human form of LEGAL_VERSION

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

const TERMS = page(
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
<p>You can cancel free of charge within the window shown in the app for your order. After a business has started acting on your order, a cancellation fee may apply — the app always shows you the cost before you confirm a cancellation.</p>

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

const PRIVACY = page(
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
<li><b>Verification documents (partners and, where required, customers):</b> government ID and, for movers, licence, insurance and related documents. These are stored privately and are only viewable by our verification team through short-lived signed links, each access logged.</li>
<li><b>A registration selfie</b> to deter account fraud; it becomes your in-app photo.</li>
</ul>

<h2>2. What we do NOT collect</h2>
<p>Swift never holds your order money, so we do not collect card numbers or wallet credentials. If you pay a business through MMG, that payment happens in MMG's own flow under MMG's terms — we only record that the business confirmed receiving it.</p>

<h2>3. How data is used</h2>
<p>To run the service: matching orders to movers, live tracking, receipts, safety features (trip sharing, SOS with live coordinates), fraud and abuse prevention (strikes, collusion checks), and legally required record-keeping. Aggregated, de-identified statistics (e.g. orders per day) carry no personal data.</p>

<h2>4. Sharing</h2>
<p>A business sees what it needs to fulfil your order (items, first name, delivery address). A mover sees pickup/drop-off details and your first name. Movers and customers see each other's ratings. We share data with authorities only where the law requires it.</p>

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

export async function legalRoutes(app: FastifyInstance) {
  app.get('/terms', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return TERMS;
  });
  app.get('/privacy', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return PRIVACY;
  });
}
