import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [G2] The vendor item editor offers bulk as three WORDS, never a number.
//
// The reason this is a test and not a convention: the moment someone adds an
// `InlineInput keyboardType="number-pad"` for "units", every shop invents its
// own scale and dispatch's load banding means nothing. The word is the contract.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const STACK = strip(readFileSync(new URL('./VendorStack.tsx', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../../services/api.ts', import.meta.url), 'utf8'));

describe('the editor sends a word', () => {
  it('the input type carries bulk as a three-word union and no bulkUnits', () => {
    const block = API.slice(API.indexOf('export interface VendorItemInput'), API.indexOf('export const vendorApi'));
    expect(block).toMatch(/bulk\?: 'normal' \| 'bulky' \| 'very_bulky';/);
    expect(block).not.toContain('bulkUnits');
  });

  it('the save payload includes the word and never a number', () => {
    const payload = STACK.slice(STACK.indexOf('const saved: any = await save.mutateAsync'), STACK.indexOf('let current = requireAuthSessionForPrincipal(owner);'));
    expect(payload).toMatch(/^\s*bulk,\s*$/m);
    expect(payload).not.toContain('bulkUnits');
  });

  it('is a Segmented three-way control, not a number pad', () => {
    const editor = STACK.slice(STACK.indexOf('How bulky is one of these to carry?'));
    const control = editor.slice(0, editor.indexOf('</Segmented>') > 0 ? editor.indexOf('</Segmented>') : 900);
    for (const key of ["'normal'", "'bulky'", "'very_bulky'"]) expect(control).toContain(key);
    expect(control).not.toContain('number-pad');
  });

  it('an item saved before the field existed reads as normal', () => {
    expect(STACK).toContain("useState<'normal' | 'bulky' | 'very_bulky'>(existing?.bulk ?? 'normal')");
  });

  it('only goods get the control — a service has nothing to carry', () => {
    // The control sits inside the non-service branch of the editor, after the
    // stock/unit row, so a hairdresser is never asked how bulky a haircut is.
    const inventory = STACK.indexOf('Inventory (optional)');
    const control = STACK.indexOf('How bulky is one of these to carry?');
    expect(inventory).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(inventory);
  });
});
