import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [F-1218-01] THE CONFIRM CARD SHOWS EVERY ROW THE IMPORT WILL CREATE.
//
// The bulk-import screen used to render the first five preview rows under a
// button that imported all of them. Independent review of #1218 put a wrongly
// priced menu row sixth: the vendor could not see it and could only confirm it.
// Mobile has no render tests, so this is a source-level guard in the style of
// vendorPreviewReadonly.test.ts: the whole preview is rendered, never a slice,
// and a server that sent fewer rows than it found says so on the card.
// ---------------------------------------------------------------------------

const screen = readFileSync(
  join(process.cwd(), 'src/modules/vendor/screens/VendorBulkImportScreen.tsx'),
  'utf8',
);

describe('[F-1218-01] the bulk-import confirm card is complete', () => {
  it('renders every preview row the server sent, never a capped slice', () => {
    expect(screen).toMatch(/\(mapped\.preview \?\? \[\]\)\.map\(/);
    expect(screen).not.toMatch(/mapped\.preview[^\n]*\.slice\(/);
  });

  it('says when the rows on the card are fewer than the rows the import will create', () => {
    expect(screen).toMatch(/\(mapped\.preview\?\.length \?\? 0\) < \(mapped\.rowCount \?\? 0\)/);
    expect(screen).toContain('Showing the first ');
  });
});
