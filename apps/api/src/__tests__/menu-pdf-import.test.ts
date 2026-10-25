import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import { PDFParse } from 'pdf-parse';
import { parseMenuText } from '../utils/menu-text-parse';

// ---------------------------------------------------------------------------
// [F-1218-01] THE MENU PARSER IS GRADED ON A REAL PDF, NOT ON A STRING.
//
// Independent review of #1218 built a menu PDF whose numbered items sat past
// the confirm card's row cap, read it with the installed pdf-parse, and watched
// "Combo 2   500" leave the text layer as "Combo 2 500" — which the parser read
// as the item "Combo" at 2,500. The vendor was shown five rows and a button
// that imported seven.
//
// The fixture here is that shape: built in memory with pdfkit and read with
// pdf-parse exactly as the route reads an upload. No file, no service, no
// network. The second half grades the flow around the parser: every row the
// route proposes must reach the confirm card, because a parser is only ever as
// safe as what the vendor can see before "Import".
// ---------------------------------------------------------------------------

/** The confirm card used to render only this many rows. The numbered items sit past it. */
const OLD_PREVIEW_CAP = 5;

const MENU_LINES = [
  'Dish A   $500',
  'Dish B   $500',
  'Dish C   $500',
  'Dish D   $500',
  'Dish E   $500',
  'Combo 2   500', // row 6: "Combo 2" at 500, or "Combo" at 2 500 — the line does not say
  'Meal for 2   750', // row 7: the same shape
  'Combo 3   $1,800', // row 8: a numbered name the currency mark settles
];

async function menuPdf(lines: readonly string[]): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', resolve);
  });
  for (const line of lines) doc.text(line);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** The route's own read of an upload: pdf-parse, then the first 12,000 characters of the text layer. */
async function textLayerOf(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    const parsed = await parser.getText();
    return (parsed.text ?? '').trim().slice(0, 12_000);
  } finally {
    await parser.destroy();
  }
}

describe('[F-1218-01] parseMenuText on a real PDF text layer', () => {
  it('the text layer collapses the column gap, so a numbered row arrives with two readings', async () => {
    const text = await textLayerOf(await menuPdf(MENU_LINES));
    expect(text).toContain('Combo 2 500');
    expect(text).not.toContain('Combo 2   500');
    // The fixture keeps the rows past the old cap, where nothing showed them.
    expect(MENU_LINES.indexOf('Combo 2   500')).toBeGreaterThanOrEqual(OLD_PREVIEW_CAP);
  });

  it('a numbered name is never cut at its digit to make a bigger price', async () => {
    const drafts = parseMenuText(await textLayerOf(await menuPdf(MENU_LINES)));
    for (const d of drafts) {
      expect(['Combo', 'Meal for'], `"${d.name}" at ${d.basePrice} is a name cut at its digit`).not.toContain(d.name);
    }
    // What IS read is exactly what the page says; the two ambiguous rows are
    // left for the vendor, not guessed.
    expect(drafts.map((d) => [d.name, d.basePrice])).toEqual([
      ['Dish A', 500],
      ['Dish B', 500],
      ['Dish C', 500],
      ['Dish D', 500],
      ['Dish E', 500],
      ['Combo 3', 1800],
    ]);
  });
});

describe('[F-1218-01] every proposed row is inspectable before import', () => {
  const routes = readFileSync(join(__dirname, '../modules/vendor/vendor.routes.ts'), 'utf8');
  const start = routes.indexOf("app.post('/items/import/menu-parse'");
  const end = routes.indexOf("app.post('/items/import',", start);
  const handler = routes.slice(start, end);

  it('the menu-parse handler is where this file thinks it is', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("source: 'menu-pdf'");
  });

  it('the route returns every row it proposes — a capped preview hides the wrong one', () => {
    // The confirm CSV carries every row; the preview must carry the same rows,
    // or the vendor confirms what they were never shown.
    expect(handler).not.toMatch(/preview:\s*normalized\.slice\(/);
    expect(handler).toMatch(/preview:\s*normalized,/);
  });
});
