import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF] The sign-up page's first load carried the store map picker (its map,
// place search and location code, about a fifth of the page's own code),
// though only a store owner on the business step ever opens it. The picker's
// code now loads on demand (ahead of the tap, once a store reaches that step);
// its stylesheet stays in the page so the on-demand piece is code only. The
// picker's behaviour is unchanged (store-pin.test.tsx); a failed fetch is
// covered by store-picker-retry.test.tsx.
// ---------------------------------------------------------------------------

const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const loader = readFileSync(join(__dirname, 'store-picker-loader.ts'), 'utf8');
const staticImports = page.split('\n').filter((line) => /^import\s/.test(line));

describe('[PERF] the sign-up page does not load the store map picker up front', () => {
  it('imports the picker’s code only on demand (a type import costs nothing at run time)', () => {
    expect(staticImports.filter((line) => /store-location-picker'/.test(line) && !/^import type /.test(line))).toEqual([]);
    expect(staticImports).toContain("import { loadStorePicker } from './store-picker-loader';");
    expect(loader).toContain("export const loadStorePicker = () => import('@/components/store-location-picker');");
    expect(loader.split('\n').filter((line) => /^import\s/.test(line))).toEqual([]);
  });

  it('keeps the picker’s stylesheet in the page, so only code is fetched on demand', () => {
    expect(staticImports).toContain("import '@/components/store-location-picker.module.css';");
  });
});
