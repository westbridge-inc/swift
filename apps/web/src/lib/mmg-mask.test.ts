import { describe, expect, it } from 'vitest';
import { maskMmgNumber } from './mmg-mask';

// ---------------------------------------------------------------------------
// [WEB-SETTINGS · owner 31 Oct 2026] The store's MMG number is where its customers' money goes. The website shows it
// masked only: enough for the owner to tell "that's mine" from "that wasn't me", never the whole number. Synthetic
// numbers only.
// ---------------------------------------------------------------------------

describe('[WEB-SETTINGS] the masked MMG number', () => {
  it('keeps +592 and the last three digits, nothing else', () => {
    expect(maskMmgNumber('+5926001234')).toBe('+592 ••• •234');
    expect(maskMmgNumber('+592 600 1234')).toBe('+592 ••• •234');
    expect(maskMmgNumber('6001234')).toBe('+592 ••• •234');
  });

  it('never shows the first digits of the line', () => {
    const shown = maskMmgNumber('+5926781234')!;
    expect(shown).not.toContain('678');
    expect(shown.replace(/\D/g, '')).toBe('592234');
  });

  it('a value of any other shape is masked whole', () => {
    expect(maskMmgNumber('+59212')).toBe('+592 ••• ••••');
    expect(maskMmgNumber('+1 555 0100 2233')).toBe('+592 ••• ••••');
  });

  it('nothing to show is null, never an invented number', () => {
    expect(maskMmgNumber(null)).toBeNull();
    expect(maskMmgNumber(undefined)).toBeNull();
    expect(maskMmgNumber('   ')).toBeNull();
    expect(maskMmgNumber(42 as unknown as string)).toBeNull();
  });
});
