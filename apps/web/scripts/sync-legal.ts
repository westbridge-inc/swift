/**
 * Snapshot the DGP-1 legal documents into the web app.  [SITE-1.1 Part 2]
 *
 * WHY THIS EXISTS
 * ---------------
 * The legal text has exactly one author and one home: the DGP-1 constants in
 * `apps/api/src/modules/legal/legal.routes.ts`. The mobile app links to the
 * API's copy; the public site must render the same words.
 *
 * But the site is Apple's and Google's evidence that this company exists, and
 * SITE-1.1 is explicit that "the marketing site must not depend on the API
 * being up." A page that 502s during an API deploy is a page that can fail an
 * enrollment check.
 *
 * So: one source, snapshotted at build time into a committed module. The site
 * serves static HTML with no runtime dependency, and `--check` fails CI the
 * moment the snapshot drifts from the source.
 *
 *   pnpm --filter @swift/web legal:sync          regenerate the snapshot
 *   pnpm --filter @swift/web legal:sync --check   fail if it is stale
 *
 * This script COPIES text. It never writes, edits, summarises or reformats a
 * single legal word — SITE-1.1: "The agent writes no legal text."
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGAL_VERSION, TERMS, PRIVACY } from '../../api/src/modules/legal/legal.routes';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/legal/generated.ts');

/** Pull the document body out of the API's full-page HTML wrapper. The wrapper
 *  is the API's own chrome (its <style>, its heading, its "Last updated" line);
 *  the site supplies its own. Only what sits inside <main> is the document. */
function extractBody(html: string): { body: string; lastUpdated: string } {
  const main = /<main>([\s\S]*?)<\/main>/.exec(html);
  if (!main) throw new Error('sync-legal: no <main> in the source document — the page() wrapper changed shape');

  const updated = /<p class="muted">Last updated:\s*([^<]+)<\/p>/.exec(main[1]!);
  if (!updated) throw new Error('sync-legal: no "Last updated" line — the page() wrapper changed shape');

  // Drop the API's brand line, its <h1> and its own last-updated paragraph:
  // the site renders all three itself, from site.config and this file.
  const body = main[1]!
    .replace(/<p class="brand">[\s\S]*?<\/p>/, '')
    .replace(/<h1>[\s\S]*?<\/h1>/, '')
    .replace(/<p class="muted">[\s\S]*?<\/p>/, '')
    .trim();

  return { body, lastUpdated: updated[1]!.trim() };
}

const terms = extractBody(TERMS);
const privacy = extractBody(PRIVACY);

if (terms.lastUpdated !== privacy.lastUpdated) {
  throw new Error(
    `sync-legal: Terms and Privacy disagree on the effective date ` +
      `("${terms.lastUpdated}" vs "${privacy.lastUpdated}"). LEGAL_VERSION covers both — fix the source.`,
  );
}

const generated = `// ─────────────────────────────────────────────────────────────────────────────
//  GENERATED — DO NOT EDIT BY HAND.
//
//  Source of truth: apps/api/src/modules/legal/legal.routes.ts  (DGP-1)
//  Regenerate:      pnpm --filter @swift/web legal:sync
//  CI guard:        pnpm --filter @swift/web legal:sync -- --check
//
//  Editing this file instead of the source will be silently overwritten and
//  will fail the drift check. Legal text is authored in exactly one place.
// ─────────────────────────────────────────────────────────────────────────────

/** Machine version stamped onto User.tosVersion at signup consent. */
export const LEGAL_VERSION = ${JSON.stringify(LEGAL_VERSION)} as const;

/** Human-readable effective date, as published. */
export const LEGAL_LAST_UPDATED = ${JSON.stringify(terms.lastUpdated)} as const;

export const TERMS_BODY = ${JSON.stringify(terms.body)};

export const PRIVACY_BODY = ${JSON.stringify(privacy.body)};
`;

const check = process.argv.includes('--check');

if (check) {
  if (!existsSync(OUT)) {
    console.error('sync-legal: snapshot missing. Run: pnpm --filter @swift/web legal:sync');
    process.exit(1);
  }
  if (readFileSync(OUT, 'utf8') !== generated) {
    console.error(
      'sync-legal: the published legal text has drifted from the snapshot.\n' +
        '  The site would serve different words than the API and the mobile app.\n' +
        '  Fix: pnpm --filter @swift/web legal:sync  (then commit the result)',
    );
    process.exit(1);
  }
  console.log(`sync-legal: snapshot is current (version ${LEGAL_VERSION}).`);
} else {
  writeFileSync(OUT, generated, 'utf8');
  console.log(`sync-legal: wrote ${OUT} (version ${LEGAL_VERSION}, updated ${terms.lastUpdated}).`);
}
