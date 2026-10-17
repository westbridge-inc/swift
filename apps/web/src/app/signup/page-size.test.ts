import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF] The sign-up page's first load carried the store map picker (its map,
// place search and location code, about a fifth of the page's own code),
// though only a store owner on the business step ever opens it. The picker's
// code now loads on demand (ahead of the tap, once a store reaches that step);
// its stylesheet stays in the page so the on-demand piece is code only. The
// picker's behaviour is unchanged and stays covered by store-pin.test.tsx.
// ---------------------------------------------------------------------------

const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const staticImports = source.split('\n').filter((line) => /^import\s/.test(line));

describe('[PERF] the sign-up page does not load the store map picker up front', () => {
  it('imports the picker only on demand, never statically', () => {
    expect(staticImports.filter((line) => /store-location-picker'/.test(line))).toEqual([]);
    expect(source).toContain("const loadStorePicker = () => import('@/components/store-location-picker');");
    expect(source).toMatch(/const StoreLocationPicker = lazy\(\(\) => loadStorePicker\(\)/);
  });

  it('keeps the picker’s stylesheet in the page, so only code is fetched on demand', () => {
    expect(staticImports).toContain("import '@/components/store-location-picker.module.css';");
  });

  it('starts fetching the picker when a store reaches its business step, and shows a status line while it arrives', () => {
    expect(source).toContain("useEffect(() => { if (step === 'business') void loadStorePicker().catch(() => undefined); }, [step]);");
    expect(source).toMatch(/<Suspense fallback=\{<p role="status"[^>]*>Loading the map…<\/p>\}>\s*<StoreLocationPicker /);
  });
});
