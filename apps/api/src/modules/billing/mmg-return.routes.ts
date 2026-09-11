import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// [MMG Checkout] WHERE MMG SENDS THE PAYER'S BROWSER AFTERWARDS.
//
// MMG asked for a success URL and an error URL for the Checkout (redirect)
// flow. These are those two pages.
//
// ⚠️ THE ONE RULE THIS FILE EXISTS TO HOLD: A REDIRECT IS NOT PROOF OF PAYMENT.
//
// The payer controls their own browser. They can open the success URL directly,
// bookmark it, replay it, or share it. Anything that marked money received
// because this endpoint was hit would hand every user a free subscription, and
// would do it silently. So these handlers:
//
//   * write NOTHING about money — no payment row, no subscription state, no
//     ledger posting, no balance change;
//   * read no request-controlled value into a decision;
//   * do not decrypt or trust the `token` MMG appends. The private key stays
//     out of this path entirely, because nothing here needs it.
//
// The money truth comes from the server asking MMG directly — the existing
// initiate/lookup/settle path in `billing.service.ts`, which reconciles against
// MMG's own record and is the only writer of a captured payment. That is true
// whether or not the payer's browser ever comes back here (they may close the
// tab, lose signal, or approve on a different device), which is exactly why the
// redirect cannot be load-bearing.
//
// So what these pages do is TELL A HUMAN WHAT IS HAPPENING, honestly: the
// payment is being confirmed with MMG, and their account updates when it is.
// They deliberately do not say "payment successful" on the success URL — this
// endpoint does not know that, and claiming it would be the same lie in copy
// that trusting the redirect would be in code.
// ---------------------------------------------------------------------------

const page = (title: string, heading: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — Swift</title>
<style>
  body{font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#fff;color:#1c1c1e;line-height:1.55}
  main{max-width:520px;margin:0 auto;padding:48px 20px 64px}
  h1{font-size:24px;margin:0 0 12px} p{font-size:15px;margin:0 0 14px}
  .muted{color:#6e6e73;font-size:13px;margin-top:28px}
  .brand{color:#E8192C;font-weight:700;margin-bottom:24px}
</style>
</head>
<body><main>
<p class="brand">Swift</p>
<h1>${heading}</h1>
${body}
</main></body></html>`;

/** Neither page varies by request, so both are constants — nothing
 *  request-controlled can reach the markup, and there is no reflection to
 *  escape. */
export const MMG_RETURN_PENDING = page(
  'Confirming your payment',
  'Thanks — we’re confirming your payment',
  `<p>Mobile Money Guyana is confirming this payment with us now. Your account
   updates automatically as soon as they do; that is usually seconds, but it can
   take a little longer.</p>
   <p>You can close this page. Nothing else is needed from you, and you do not
   need to pay again.</p>
   <p class="muted">If your account has not updated within a few minutes, contact
   support and quote the date and time — we can look the payment up directly
   with MMG.</p>`,
);

export const MMG_RETURN_PROBLEM = page(
  'Payment not completed',
  'That payment didn’t go through',
  `<p>Mobile Money Guyana reported a problem, or the request was cancelled. No
   fee has been taken.</p>
   <p>You can try again from the app. If money did leave your wallet, do not pay
   again — contact support and we will check it against MMG’s record.</p>
   <p class="muted">Nothing about your account has changed.</p>`,
);

export async function mmgReturnRoutes(app: FastifyInstance) {
  // Public and unauthenticated BY NECESSITY: MMG redirects a browser here and
  // there is no session to rely on. Safe precisely because neither handler
  // reads the request or writes anything.
  app.get('/success', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return MMG_RETURN_PENDING;
  });

  app.get('/error', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return MMG_RETURN_PROBLEM;
  });
}
