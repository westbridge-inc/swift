import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH · 5 Nov 2026] Words on the public website that stopped being true when Swift opened in full.
//  - The menu reader takes a PDF with a text layer; a photo or a scan is refused (vendor.routes.ts menu-parse).
//  - Swift is not "in a pilot".
//  - "Most ... clear review within a day" has no history behind it.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('[FULL-LAUNCH] the public words are true on the day', () => {
  it('For businesses claims only the menu import that exists, where it exists: a typed PDF in the app, never a photo', () => {
    const page = read('app/(marketing)/vendors/page.tsx');
    expect(page).not.toMatch(/photograph a paper menu|let Swift read it/i);
    // The list is headed "runs today on the web"; the PDF import is the phone's, so the sentence says where it works.
    expect(page).toContain('Add items one at a time or import a spreadsheet. In the Swift app you can also upload a typed PDF menu (not a photo or a scan).');
  });

  it('no customer or partner page says "during the pilot"', () => {
    const hits = sources(SRC).filter((file) => /during the pilot/i.test(readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('no page says "most" partners clear review, on any switch', () => {
    const hits = sources(SRC).filter((file) => /clear review/i.test(readFileSync(file, 'utf8')));
    expect(hits).toEqual([]);
  });
});
