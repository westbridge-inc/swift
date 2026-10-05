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


describe('catalogue CSV resource bounds', () => {
  it('rejects more than 5000 data rows before header expansion', () => {
    expect(() => parseCsvWithHeader('name\n' + 'x\n'.repeat(5001))).toThrow(/5000/);
  });
  it('rejects wide headers and ragged rows while tokenising', () => {
    expect(() => parseCsvWithHeader(Array(101).fill('h').join(',') + '\nx')).toThrow(/100/);
    expect(() => parseCsvWithHeader('name\n' + Array(101).fill('x').join(','))).toThrow(/100/);
  });
  it('bounds quoted field growth and empty-cell allocations', () => {
    expect(() => parseCsvWithHeader('name\n"' + 'x'.repeat(2049) + '"')).toThrow(/2048/);
    expect(() => parseCsvWithHeader('name\n' + (','.repeat(99) + '\n').repeat(5002))).toThrow(/cells/);
  });
  it('accepts exactly 5000 rows, blank lines, CRLF and quoted newlines', () => {
    expect(parseCsvWithHeader('name\r\n\r\n' + 'x\r\n'.repeat(5000))).toHaveLength(5000);
    expect(parseCsvWithHeader('name\n"a\nb"')).toEqual([{ name: 'a\nb' }]);
  });
  it('preserves special header keys as data', () => {
    const [row] = parseCsvWithHeader('__proto__,constructor\nx,y');
    expect(Object.keys(row!)).toEqual(['__proto__', 'constructor']);
    expect(row!['__proto__']).toBe('x');
  });
});
