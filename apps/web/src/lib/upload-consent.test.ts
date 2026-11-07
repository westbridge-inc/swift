import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [R17 · legal research D2/B1] The website's document upload has always had a consent tick; the API now records
// it in the consent ledger, anchored to the tick's exact words. So the words on the page must be the words the
// API anchors to (apps/api verification/upload-consent.ts, document_v1), and the upload must say it showed them.
// ---------------------------------------------------------------------------

const API = readFileSync(join(process.cwd(), '..', 'api', 'src', 'modules', 'verification', 'upload-consent.ts'), 'utf8');
const PAGE = readFileSync(join(process.cwd(), 'src', 'app', 'portal', 'documents', 'page.tsx'), 'utf8');
const MOVER_API = readFileSync(join(process.cwd(), 'src', 'lib', 'mover-api.ts'), 'utf8');

const apiText = /document_v1: \{[\s\S]*?text: '([^']+)'/.exec(API)?.[1];
/** The label as a person reads it: JSX tags and {' '} removed, whitespace collapsed. */
const label = (() => {
  const m = /<span>\s*(I consent to Swift processing this document[\s\S]*?)<\/span>\s*<\/label>/.exec(PAGE);
  return m?.[1]!.replace(/\{' '\}/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
})();

describe('the website upload tick says the recorded words', () => {
  it('the label is the API’s document_v1 text, word for word', () => {
    expect(apiText).toBeTruthy();
    expect(label).toBe(apiText);
  });

  it('the upload tells the API it showed the tick', () => {
    expect(MOVER_API).toMatch(/consentTick: 'document_v1'/);
  });

  it('no review-time promise faster than the support hours', () => {
    expect(PAGE).not.toMatch(/within 24 hours/);
    // [Owner 30 Oct 2026] Support and document review: Monday to Saturday, 8:00–16:00 Guyana time.
    expect(PAGE).toContain('Monday to Saturday, 8:00–16:00 Guyana time');
    expect(PAGE).not.toContain('20:00');
  });
});
