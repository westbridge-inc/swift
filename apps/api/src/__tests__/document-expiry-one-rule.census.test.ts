import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026] ONE RULE FOR A DOCUMENT'S EXPIRY: valid through the end of its expiry day
// in Guyana (modules/verification/document-validity.ts). This census keeps it one rule: the query idiom that
// compares an expiry with now ({ expiresAt: null }, { expiresAt: { gt: now } } / expiresOn: { gt: ... }) and a raw
// JS comparison of an expiry with now are refused outside the ledger below, and every server reader of a document
// expiry goes through the helper.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
  return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
});
const SOURCES = files(join(SRC, 'modules')).map((path) => ({ rel: relative(SRC, path).split('\\').join('/'), text: readFileSync(path, 'utf8') }));

/** Not document expiries: the same idiom on other models, each with its reason. */
const NOT_A_DOCUMENT: Record<string, string> = {
  'modules/integrity/enforcement.ts': 'an identity-cluster enforcement window, a moment',
  'modules/integrity/trial-entitlement.service.ts': 'an identity-cluster trial entitlement window, a moment',
};

const QUERY_IDIOM = /\{\s*expires(At|On):\s*null\s*\},\s*\{\s*expires(At|On):\s*\{\s*(gt|gte)\b|expiresOn:\s*\{\s*(gt|gte|lt|lte)\b/g;
const JS_COMPARE = /expires(At|On)\??(\.getTime\(\))?\s*(<|>|<=|>=)\s*(now|new Date\(\)|Date\.now\(\))/g;

/** The server readers of a document's expiry: each must read it through document-validity.ts. */
const READERS = [
  'modules/verification/evidence.ts',
  'modules/verification/category-gate.ts',
  'modules/verification/storefront-disclosure.ts',
  'modules/vendor/vendor-tier.ts',
  'modules/verification/mover-document-authority.ts',
  'modules/verification/verification.service.ts',
  'modules/verification/renewal-schedule.ts',
];

describe('[FOLLOWUPS] a document\'s expiry is judged by one rule', () => {
  it('the expiry-vs-now query idiom appears only on models that are not documents', () => {
    const hits = SOURCES.flatMap(({ rel, text }) => {
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      return (code.match(QUERY_IDIOM) ?? []).map(() => rel);
    }).filter((rel) => !(rel in NOT_A_DOCUMENT));
    expect(hits, 'route these through validExpiryOr / lapsedExpiryAnd (document-validity.ts)').toEqual([]);
  });

  it('no document module compares an expiry with now in JS', () => {
    const hits = SOURCES.filter(({ rel }) => /^modules\/(verification|vendor)\//.test(rel) && rel !== 'modules/verification/document-validity.ts')
      .flatMap(({ rel, text }) => (text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').match(JS_COMPARE) ?? []).map((m) => `${rel}: ${m}`));
    expect(hits, 'use isDocumentValidAt / documentLapsesAt (document-validity.ts)').toEqual([]);
  });

  it('every server reader of a document expiry goes through document-validity.ts', () => {
    for (const rel of READERS) {
      const text = SOURCES.find((s) => s.rel === rel)?.text ?? '';
      expect(text, rel).toMatch(/from '\.{1,2}\/(verification\/)?document-validity'/);
    }
  });
});
