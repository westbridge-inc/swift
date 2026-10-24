import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogueCheckLine, importCheckSummary, importPhotoNotesLine } from './catalogueCheck';

const SRC = process.cwd().endsWith('apps/mobile')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'mobile', 'src');

// [GUARDRAILS §8] Owner ruling (13 Oct): the partner sees "Waiting for a quick check"
// on an item a banned word is holding, and the owner's own words on an item Swift
// does not allow. Mobile has no render tests, so the screens are guarded by source.
describe('the partner reads why Swift hides an item', () => {
  it('a held item says it is waiting, and what happens next', () => {
    expect(catalogueCheckLine({ status: 'WAITING_FOR_CHECK', message: 'Waiting for a quick check', prohibitedClass: 'ALCOHOL', field: 'name', term: 'rum' }))
      .toBe('Waiting for a quick check — hidden from customers until Swift checks it.');
  });
  it('an item Swift does not allow says so in the owner\'s words, with the reason when a person gave one', () => {
    expect(catalogueCheckLine({ status: 'NOT_ALLOWED', message: 'Swift doesn\'t allow this item: medicines.', reason: null }))
      .toBe('Swift doesn\'t allow this item: medicines.');
    expect(catalogueCheckLine({ status: 'NOT_ALLOWED', message: 'Swift doesn\'t allow this item: medicines.', reason: 'Sold as a cure' }))
      .toBe('Swift doesn\'t allow this item: medicines. Reason: Sold as a cure');
  });
  it('says nothing for an ordinary item, or an older server that sends no check', () => {
    expect(catalogueCheckLine(null)).toBeNull();
    expect(catalogueCheckLine(undefined)).toBeNull();
  });
  it('the import summary counts the held rows, and is silent when there are none', () => {
    expect(importCheckSummary({ waitingForCheckCount: 2 })).toBe(' · 2 waiting for a quick check');
    expect(importCheckSummary({ waitingForCheckCount: 0 })).toBe('');
    expect(importCheckSummary({})).toBe('');
  });
  it('the menu and the bulk import screens both show it', () => {
    const menu = readFileSync(join(SRC, 'modules/vendor/screens/VendorMenuScreen.tsx'), 'utf8');
    // The line is rendered when there is one — not merely computed.
    expect(menu).toMatch(/\{catalogueCheckLine\(item\.catalogueCheck\) \? \(\s*<T[^>]*>\s*\{catalogueCheckLine\(item\.catalogueCheck\)\}/);
    const bulk = readFileSync(join(SRC, 'modules/vendor/screens/VendorBulkImportScreen.tsx'), 'utf8');
    // Rendered inside the summary line, not merely called.
    expect(bulk).toMatch(/\{failedCount \? [^\n]*\}\s*\{importCheckSummary\(result\)\}\.\s*<\/T>/);
  });
  it('the import names the rows that came in without their photo address [IMAGES-E2E PR4], and the bulk import screen shows it', () => {
    expect(importPhotoNotesLine({ notes: [{ row: 3 }], notesCount: 1 }))
      .toBe('1 row was imported without a photo (row 3). Add photos by uploading them on each item.');
    expect(importPhotoNotesLine({ notes: [{ row: 2 }, { row: 5 }], notesCount: 7 }))
      .toBe('7 rows were imported without a photo (rows 2, 5…). Add photos by uploading them on each item.');
    expect(importPhotoNotesLine({ notesCount: 0 })).toBeNull();
    expect(importPhotoNotesLine({})).toBeNull();
    const bulk = readFileSync(join(SRC, 'modules/vendor/screens/VendorBulkImportScreen.tsx'), 'utf8');
    expect(bulk).toMatch(/\{importPhotoNotesLine\(result\) \? \(\s*<T[^>]*>\{importPhotoNotesLine\(result\)\}<\/T>/);
  });
});
