import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docTypeName } from '../modules/verification/doc-names';
import { approvedNotice, rejectedNotice } from '../modules/verification/verification.service';

// [BUG-HUNT F07] A notice names a document the way the person's checklist does.
describe('document names in notices', () => {
  it('reads as the checklist does, never a lowercased code', () => {
    expect(approvedNotice('owner_national_id').body).toBe('Your Owner National ID or Digital ID card has been approved.');
    expect(approvedNotice('gra_restaurant_licence').body).toBe('Your GRA Food Restaurant Licence has been approved.');
    expect(rejectedNotice('drivers_licence', 'too dark').body).toBe("Your Driver's Licence was rejected: too dark. Please fix it and resubmit.");
  });

  it('a code neither list knows still reads as words', () => {
    expect(docTypeName('some_new_paper')).toBe('Some New Paper');
  });

  it('holds the same names as the phone', () => {
    const phone = readFileSync(join(__dirname, '../../../mobile/src/components/onboarding/docLabels.ts'), 'utf8');
    const rows = [...phone.matchAll(/^\s+([a-z_]+): (?:'([^']+)'|"([^"]+)"),$/gm)];
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) expect(docTypeName(row[1]!), row[1]).toBe(row[2] ?? row[3]);
  });
});
