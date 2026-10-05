import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// [L13 item 5] Every screen that draws a native map shows the map and routing
// credits. A new map screen without them is the regression this catches; the
// rendered credit behaviour itself is graded in StoreLocationPicker.test.ts.

const SRC = join(__dirname, '..');
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function mapScreens(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'node_modules' && entry !== '__flagoff__') mapScreens(full, out); continue; }
    if (!/\.tsx$/.test(entry) || /\.test\.tsx$/.test(entry)) continue;
    if (/<MapView[\s>]/.test(code(readFileSync(full, 'utf8')))) out.push(full);
  }
  return out;
}

describe('map credits census', () => {
  const screens = mapScreens(SRC);

  it('finds the map screens (guard: the census is not vacuous)', () => {
    expect(screens.length).toBeGreaterThanOrEqual(8);
  });

  it.each(screens.map((file) => [relative(SRC, file), file]))('%s renders MapCredits', (_name, file) => {
    expect(code(readFileSync(file, 'utf8'))).toMatch(/<MapCredits\b/);
  });
});
