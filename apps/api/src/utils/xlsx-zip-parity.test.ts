import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { scanXlsxZip, XlsxZipGuardError, XLSX_IMPORT_ZIP_BUDGET, type XlsxZipBudget } from './xlsx-zip-guard';

// ---------------------------------------------------------------------------
// [SEC-DOS F3] The XLSX guard must read an archive exactly as JSZip (under
// exceljs) reads it, or refuse it. JSZip finds the LAST end record, shifts its
// offsets when bytes were prepended, and walks the central directory for as
// long as the signature matches — whatever count the end record claims. So an
// end record that names one harmless entry can hide a second one that JSZip
// still inflates. Every archive here is built by hand in the test, small: the
// "bomb" is a few hundred KB of zeros measured against a small test budget.
// The guard also hands exceljs a rebuilt archive of only the bytes it measured.
// ---------------------------------------------------------------------------

const jszip = createRequire(require.resolve('exceljs'))('jszip') as { loadAsync: (b: Buffer) => Promise<{ files: Record<string, { dir: boolean; async: (t: 'nodebuffer') => Promise<Buffer> }> }> };

/** A small budget, so a "bomb" can be small: 64 KB per entry, 128 KB in all. */
const SMALL: XlsxZipBudget = { maxEntryUncompressed: 64 * 1024, maxTotalUncompressed: 128 * 1024, maxEntries: 50 };
const BOMB = Buffer.alloc(400 * 1024); // inflates past SMALL's per-entry cap

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry { name: string; content: Buffer; declared?: number }
interface Part { local: Buffer; central: Buffer }

/** One entry: its local record (header + name + deflated data) and its central record, local offset patched later. */
function part(entry: Entry): Part & { patch: (offset: number) => void } {
  const name = Buffer.from(entry.name);
  const data = deflateRawSync(entry.content);
  const declared = entry.declared ?? entry.content.length;
  const crc = crc32(entry.content);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(declared, 22);
  header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(name.length, 28);
  const centralRecord = Buffer.concat([central, name]);
  return { local: Buffer.concat([header, name, data]), central: centralRecord, patch: (offset) => centralRecord.writeUInt32LE(offset, 42) };
}

function eocd(entries: number, cdSize: number, cdOffset: number, comment = Buffer.alloc(0)): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdOffset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([end, comment]);
}

/** An honest archive of these entries. */
function zip(entries: Entry[]): Buffer {
  const parts = entries.map(part);
  let offset = 0;
  for (const p of parts) { p.patch(offset); offset += p.local.length; }
  const locals = Buffer.concat(parts.map((p) => p.local));
  const centrals = Buffer.concat(parts.map((p) => p.central));
  return Buffer.concat([locals, centrals, eocd(parts.length, centrals.length, locals.length)]);
}

const reasonOf = (buffer: Buffer, budget: XlsxZipBudget = SMALL) => {
  try { scanXlsxZip(buffer, budget); return 'accepted'; } catch (err) { if (err instanceof XlsxZipGuardError) return err.reason; throw err; }
};

const HARMLESS: Entry = { name: '[Content_Types].xml', content: Buffer.from('<Types/>'.repeat(20)) };
const HIDDEN: Entry = { name: 'xl/sharedStrings.xml', content: BOMB };

describe('[SEC-DOS F3] the guard reads the directory exactly as JSZip does, or refuses it', () => {
  it('the builder is sound: an honest small archive is accepted, and JSZip reads the same entries', async () => {
    const honest = zip([HARMLESS, { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>') }]);
    expect(reasonOf(honest)).toBe('accepted');
    expect(Object.keys((await jszip.loadAsync(honest)).files).sort()).toEqual(['[Content_Types].xml', 'xl/workbook.xml']);
  });

  it('an end record that counts ONE entry while the directory holds a second (a bomb JSZip still inflates) is refused', async () => {
    const [a, b] = [part(HARMLESS), part(HIDDEN)];
    a.patch(0); b.patch(a.local.length);
    const locals = Buffer.concat([a.local, b.local]);
    // The end record COUNTS one entry; its directory (size and offset honest) holds two.
    const crafted = Buffer.concat([locals, a.central, b.central, eocd(1, a.central.length + b.central.length, locals.length)]);
    // JSZip walks while the signature matches: it sees, and would inflate, the hidden entry.
    expect(Object.keys((await jszip.loadAsync(crafted)).files)).toContain('xl/sharedStrings.xml');
    expect(reasonOf(crafted)).not.toBe('accepted');
  });

  it('an end record that counts ZERO entries is refused (JSZip reads whatever records follow)', async () => {
    const one = part(HIDDEN);
    one.patch(0);
    const crafted = Buffer.concat([one.local, one.central, eocd(0, one.central.length, one.local.length)]);
    expect(Object.keys((await jszip.loadAsync(crafted)).files)).toContain('xl/sharedStrings.xml');
    expect(reasonOf(crafted)).not.toBe('accepted');
  });

  it('an archive with no entries at all is refused', () => {
    expect(reasonOf(eocd(0, 0, 0))).not.toBe('accepted');
  });

  it('a directory whose end is not where the end record sits (bytes prepended or between) is refused', () => {
    const honest = zip([HARMLESS]);
    expect(reasonOf(Buffer.concat([Buffer.alloc(64, 0x20), honest]))).not.toBe('accepted');
    // directory size one byte short of the end record
    const shortDir = Buffer.from(honest);
    const end = shortDir.length - 22;
    shortDir.writeUInt32LE(shortDir.readUInt32LE(end + 12) - 1, end + 12);
    expect(reasonOf(shortDir)).not.toBe('accepted');
  });

  it('two directory records naming the same local header, or overlapping local data, are refused', () => {
    const a = part(HARMLESS);
    const b = part({ name: '[Content_Types].xml', content: HARMLESS.content });
    a.patch(0); b.patch(0); // both point at the first local header
    const dup = Buffer.concat([a.local, a.central, b.central, eocd(2, a.central.length + b.central.length, a.local.length)]);
    expect(reasonOf(dup)).not.toBe('accepted');
    const c = part({ name: 'xl/a.xml', content: Buffer.from('<a/>'.repeat(50)) });
    const d = part({ name: 'xl/b.xml', content: Buffer.from('<b/>'.repeat(50)) });
    c.patch(0); d.patch(10); // d's header starts inside c's
    const locals = Buffer.concat([c.local, d.local]);
    const overlap = Buffer.concat([locals, c.central, d.central, eocd(2, c.central.length + d.central.length, locals.length)]);
    expect(reasonOf(overlap)).not.toBe('accepted');
  });

  it('a later end-record signature, or bytes after the end record\'s comment, are refused (JSZip would read the later one)', () => {
    const honest = zip([HARMLESS]);
    expect(reasonOf(Buffer.concat([honest, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])]))).not.toBe('accepted');
    expect(reasonOf(Buffer.concat([honest, Buffer.from('trailing')]))).not.toBe('accepted');
  });

  it('a local file name that differs from its directory name is refused (JSZip names the entry from the LOCAL header)', () => {
    const honest = zip([HARMLESS]);
    const renamed = Buffer.from(honest);
    renamed.write('X', 30); // first byte of the local name only
    expect(reasonOf(renamed)).not.toBe('accepted');
  });
});

describe('[SEC-DOS F3] exceljs is handed only the bytes the guard measured', () => {
  it('the rebuilt archive is stored (nothing left to inflate), holds exactly the measured entries, and reads as the same workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Catalogue').addRows([['Product Name', 'Unit Cost'], ['Rice 1 kg', 450], ['Café au lait', 300]]);
    const original = Buffer.from(await workbook.xlsx.writeBuffer());
    const scan = scanXlsxZip(original, XLSX_IMPORT_ZIP_BUDGET);
    expect(Buffer.isBuffer(scan.archive)).toBe(true);
    // Every entry in the rebuilt archive is STORED, and the archive passes the guard itself.
    expect(reasonOf(scan.archive, XLSX_IMPORT_ZIP_BUDGET)).toBe('accepted');
    const cdOffset = scan.archive.readUInt32LE(scan.archive.length - 22 + 16);
    let pos = cdOffset;
    for (let i = 0; i < scan.entries; i += 1) {
      expect(scan.archive.readUInt16LE(pos + 10)).toBe(0);
      pos += 46 + scan.archive.readUInt16LE(pos + 28) + scan.archive.readUInt16LE(pos + 30) + scan.archive.readUInt16LE(pos + 32);
    }
    // JSZip sees the same names and the same bytes in both.
    const [a, b] = await Promise.all([jszip.loadAsync(original), jszip.loadAsync(scan.archive)]);
    expect(Object.keys(b.files).sort()).toEqual(Object.keys(a.files).sort());
    for (const name of Object.keys(a.files)) {
      if (a.files[name]!.dir) continue;
      expect((await b.files[name]!.async('nodebuffer')).equals(await a.files[name]!.async('nodebuffer')), name).toBe(true);
    }
    // exceljs reads the rebuilt archive as the same workbook.
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(scan.archive as unknown as ArrayBuffer);
    const rows = reread.worksheets[0]!.getSheetValues().slice(1).map((r) => (r as unknown[]).slice(1));
    expect(rows).toEqual([['Product Name', 'Unit Cost'], ['Rice 1 kg', 450], ['Café au lait', 300]]);
  });

  it('the import route hands exceljs the rebuilt archive, never the upload', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'modules/vendor/vendor.routes.ts'), 'utf8');
    const at = src.indexOf('scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET)');
    expect(at).toBeGreaterThan(-1);
    const after = src.slice(at, at + 2500);
    expect(after).toMatch(/workbook\.xlsx\.load\(measured(?: as unknown as ArrayBuffer)?\)/);
    expect(after).not.toMatch(/workbook\.xlsx\.load\(buffer/);
  });
});
