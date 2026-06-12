import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvWithHeader } from './csv';

describe('parseCsv', () => {
  it('parses plain rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with embedded commas and newlines', () => {
    expect(parseCsv('name,desc\nBurger,"Juicy, with cheese"\nWrap,"Line one\nline two"')).toEqual([
      ['name', 'desc'],
      ['Burger', 'Juicy, with cheese'],
      ['Wrap', 'Line one\nline two'],
    ]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']]);
  });

  it('handles CRLF line endings and trailing newlines', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('skips blank lines in messy files', () => {
    expect(parseCsv('a,b\n\n1,2\n   ,\n3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

describe('parseCsvWithHeader', () => {
  it('keys rows by trimmed header names and pads missing cells', () => {
    const rows = parseCsvWithHeader(' name , price \nBurger,1500\nFries');
    expect(rows).toEqual([
      { name: 'Burger', price: '1500' },
      { name: 'Fries', price: '' },
    ]);
  });

  it('returns empty for an empty file', () => {
    expect(parseCsvWithHeader('')).toEqual([]);
  });
});
