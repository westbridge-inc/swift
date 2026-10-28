import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billDateLabel } from './bill-date';

// [FEE-STATUS · owner 25 Oct 2026] A billing date that has passed is never shown as the next bill.
const NOW = Date.parse('2026-10-25T16:52:00Z');
describe('subscription billing date rows [FEE-STATUS]', () => {
  it('a date still ahead is the next bill; a passed one is "Due since"', () => {
    expect(billDateLabel('2026-11-01T00:26:00Z', NOW)).toBe('Next bill');
    expect(billDateLabel('2026-10-14T00:26:00Z', NOW)).toBe('Due since');
    expect(billDateLabel(null, NOW)).toBe('Next bill');
  });
  it.each(['components/MoverDetail.tsx', 'app/vendors/[id]/page.tsx'])('%s labels the row by the date, never a fixed "Next bill"', (file) => {
    const src = readFileSync(join(process.cwd(), 'src', file), 'utf8');
    expect(src).toContain('<Row label={billDateLabel(sub.nextBillingDate)}>');
    expect(src).not.toContain('<Row label="Next bill">');
  });
  it('the subscriptions list says "due since" for a passed date', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/subscriptions/page.tsx'), 'utf8');
    // [ADMIN-AUDIT S3-4] the same rule, now in sentence case with the date in words
    expect(src).toContain("billDateLabel(s.nextBillingDate) === 'Due since' ? `Due since ${gyDate(s.nextBillingDate)}`");
  });
});
