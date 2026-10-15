import { describe, it, expect } from 'vitest';
import { csvTextCell } from '../utils/csv';

// [security review: csv-formula-injection] A CSV a person opens in a spreadsheet
// must never carry a formula from a name, a reference or a note: OWASP's
// formula triggers (= + - @ tab CR) at the start of a cell are neutralised with
// a leading apostrophe, then the cell is quoted as RFC 4180 asks.
describe('csvTextCell', () => {
  it('neutralises a cell that starts with = + - @ tab or CR, and quotes as needed', () => {
    expect(csvTextCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvTextCell('+1+1')).toBe("'+1+1");
    expect(csvTextCell('-2+3')).toBe("'-2+3");
    expect(csvTextCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvTextCell('\tcmd')).toBe("'\tcmd");
    expect(csvTextCell('\rcmd')).toBe(`"'\rcmd"`);
  });

  it('leaves ordinary text alone, quoting only commas, quotes and line breaks', () => {
    expect(csvTextCell('Receipt Vendor 3')).toBe('Receipt Vendor 3');
    expect(csvTextCell('SWF-SWIFT-2026-000001')).toBe('SWF-SWIFT-2026-000001');
    expect(csvTextCell('a,b')).toBe('"a,b"');
    expect(csvTextCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvTextCell('')).toBe('');
  });
});
