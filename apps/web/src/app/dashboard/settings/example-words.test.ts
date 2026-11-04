import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENTS_FOOTNOTE } from '@/lib/store-documents';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · 1 Nov 2026] Two lines partners read while they set up:
// - (D4, COORD delegated) the call-us number's example was a dialable Georgetown number, which could be someone's real
//   line: it is now an obviously fake, masked pattern, on the store's Settings and on Add a branch;
// - (D5, owner ruling) the Documents footnote said "We confirm your documents are genuine", a claim Swift cannot prove;
//   it now says what happens: a person at Swift checks every document (the phone's checklist says the same:
//   store-documents.parity.test.ts).
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');
const MASKED = 'placeholder="e.g. +592 6XX XXXX"';

describe('[D4] the call-us example is a masked pattern, never a dialable number', () => {
  for (const file of ['app/dashboard/settings/call-us-card.tsx', 'app/dashboard/branches/add/page.tsx']) {
    it(file, () => {
      const source = read(file);
      expect(source).toContain(MASKED);
      expect(source).not.toMatch(/placeholder="\+592 \d{3} \d{4}"/);
    });
  }
});

describe('[D5] the Documents footnote says a person checks every document', () => {
  it('no "genuine" claim; the person, the daily expiry check and the reminder stay', () => {
    expect(DOCUMENTS_FOOTNOTE).toBe("A person at Swift checks every document, and we re‑check expiry every day — we'll remind you before anything lapses so you stay verified.");
    expect(DOCUMENTS_FOOTNOTE).not.toMatch(/genuine/i);
  });
});
