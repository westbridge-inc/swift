import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MMG_RETURN_PENDING, MMG_RETURN_PROBLEM } from '../modules/billing/mmg-return.routes';

// ---------------------------------------------------------------------------
// [MMG Checkout] THE REDIRECT MUST STAY INERT.
//
// MMG redirects the payer's BROWSER to our success/error URLs. The payer
// controls that browser: they can open the success URL directly, replay it,
// bookmark it, or send it to a friend. If hitting it ever marked money
// received, every user would have a free subscription and nothing would say so.
//
// This is the classic payment-integration trap, and it is easy to walk into
// later — the obvious "improvement" is to decrypt MMG's token here and settle
// immediately. That is why this file pins the property rather than trusting the
// comment in the module.
//
// The claim being graded is narrow and provable: THE MODULE HAS NO WAY TO WRITE.
// It is asserted from its IMPORTS, not from scanning its prose for scary words.
// A module that imports no database client, no service and no crypto key cannot
// settle a payment, whatever its handlers say.
// ---------------------------------------------------------------------------

const MODULE = path.join(__dirname, '..', 'modules', 'billing', 'mmg-return.routes.ts');
const source = readFileSync(MODULE, 'utf8');

/** Every module-level import specifier, and nothing else. */
const importedFrom = (): string[] =>
  [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);

describe('[MMG Checkout] the redirect endpoints cannot move money', () => {
  it('the module imports nothing that could write — this is the whole guarantee', () => {
    const imports = importedFrom();
    expect(imports.length, 'a census that finds no imports is not a census').toBeGreaterThan(0);
    // Fastify types only. Anything else is a new capability and must be argued
    // for in review, not arrive by autocomplete.
    expect(imports).toEqual(['fastify']);
  });

  it('...and reaches no prisma client, service, or key material by any other route', () => {
    // Belt to the imports' braces: a dynamic import or a global would bypass
    // the import census above.
    for (const forbidden of [/\bprisma\b/i, /import\s*\(/, /require\s*\(/, /readFileSync/, /process\.env/, /\.pem\b/i, /privateKey/i, /decrypt/i]) {
      expect(source, `mmg-return.routes.ts must not reference ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('the success page does NOT claim the payment succeeded — because it cannot know', () => {
    // This endpoint is reachable by anyone typing the URL. Telling them the
    // payment worked would be the same lie in copy that trusting the redirect
    // would be in code.
    for (const claim of [/payment successful/i, /payment received/i, /you have paid/i, /thank you for your payment/i]) {
      expect(MMG_RETURN_PENDING, `the success page must not assert ${claim}`).not.toMatch(claim);
    }
    // It must say what IS true: confirmation is happening server-side.
    expect(MMG_RETURN_PENDING).toMatch(/confirming/i);
  });

  it('the error page does not tell a payer to pay twice', () => {
    expect(MMG_RETURN_PROBLEM).toMatch(/do not pay again/i);
  });

  it('both pages are complete documents and are not indexed', () => {
    for (const html of [MMG_RETURN_PENDING, MMG_RETURN_PROBLEM]) {
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('name="robots" content="noindex"');
    }
  });

  it('neither page interpolates anything request-controlled', () => {
    // Both are module constants built from literals; nothing reflects into the
    // markup, so there is no escaping to get wrong.
    expect(source).toMatch(/export const MMG_RETURN_PENDING = page\(/);
    expect(source).toMatch(/export const MMG_RETURN_PROBLEM = page\(/);
    expect(source, 'handlers must return the constants, never build a page per request')
      .not.toMatch(/return page\(/);
  });
});
