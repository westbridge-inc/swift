import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { scanXlsxZip, XlsxZipGuardError, XLSX_IMPORT_ZIP_BUDGET } from './xlsx-zip-guard';

// Audit DS107 High #5 — the Excel menu import's zip-bomb guard. Red-first:
// scanXlsxZip does not exist on main, so every case below fails to import on
// main; with the fix they prove the guard refuses by ADVERTISED size before
// any inflation (no OOM, no exceljs load in the refusal path).

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;

async function tinyWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Catalogue').addRow(['Product Name', 'Unit Cost']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function findEocd(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('test zip has no EOCD');
}

/** Rewrite the first `count` central-directory entries' advertised
 *  uncompressed size (32-bit LE at entry offset +24) to `size`, leaving the
 *  stored bytes untouched — the classic zip-bomb shape. */
function declareUncompressed(buffer: Buffer, count: number, size: number): void {
  const eocd = findEocd(buffer);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  expect(totalEntries).toBeGreaterThanOrEqual(count);
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    expect(buffer.readUInt32LE(pos)).toBe(CENTRAL_DIR_SIGNATURE);
    if (i < count) buffer.writeUInt32LE(size, pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    pos += 46 + nameLen + extraLen + commentLen;
  }
}

/** A one-entry deflate ZIP built by hand, whose central directory (and local
 *  header) DECLARE `declared` uncompressed bytes whatever the stream holds. */
function handZip(content: Buffer, declared: number): Buffer {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const data = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

const reasonOf = (buffer: Buffer) => {
  try { scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET); return 'accepted'; } catch (err) { return (err as XlsxZipGuardError).reason; }
};

describe('scanXlsxZip — a directory that lies about its sizes', () => {
  it('accepts an honest hand-built entry (the builder itself is sound)', () => {
    const content = Buffer.from('<worksheet/>'.repeat(100));
    expect(reasonOf(handZip(content, content.length))).toBe('accepted');
  });

  it('refuses a bomb that DECLARES 100 bytes but inflates past the per-entry cap, without inflating past it', () => {
    // 12 MB of zeros deflates to a few KB: the advertised pass sees 100 bytes
    // and would wave it through; the capped inflate stops at 10 MB.
    const bomb = handZip(Buffer.alloc(12 * 1024 * 1024), 100);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(reasonOf(bomb)).toBe('inflated-size');
  });

  it('refuses an entry whose real size differs from its claim, even under budget', () => {
    expect(reasonOf(handZip(Buffer.alloc(5000, 7), 100))).toBe('inflated-size');
  });
});

describe('scanXlsxZip', () => {
  it('accepts a real workbook inside budget and reports its true sizes', async () => {
    const buffer = await tinyWorkbook();
    const scan = scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET);
    expect(scan.entries).toBeGreaterThan(2);
    expect(scan.totalUncompressed).toBeLessThan(XLSX_IMPORT_ZIP_BUDGET.maxTotalUncompressed);
    expect(scan.maxEntryUncompressed).toBeLessThan(XLSX_IMPORT_ZIP_BUDGET.maxEntryUncompressed);
  });

  it('refuses an entry whose advertised uncompressed size exceeds the per-entry budget', async () => {
    const buffer = await tinyWorkbook();
    declareUncompressed(buffer, 1, 64 * 1024 * 1024); // 64 MB declared, bytes stay tiny
    expect(() => scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET)).toThrow(XlsxZipGuardError);
    let caught: XlsxZipGuardError | undefined;
    try {
      scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET);
    } catch (err) {
      caught = err as XlsxZipGuardError;
    }
    expect(caught?.reason).toBe('entry-size');
  });

  it('refuses when the summed advertised sizes exceed the total budget', async () => {
    const buffer = await tinyWorkbook();
    // 8 MB per entry is under the per-entry budget but four entries sum past
    // the 30 MB total.
    declareUncompressed(buffer, 4, 8 * 1024 * 1024);
    let caught: XlsxZipGuardError | undefined;
    try {
      scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET);
    } catch (err) {
      caught = err as XlsxZipGuardError;
    }
    expect(caught?.reason).toBe('total-size');
  });

  it('refuses too many entries', async () => {
    const buffer = await tinyWorkbook();
    let caught: XlsxZipGuardError | undefined;
    try {
      scanXlsxZip(buffer, { ...XLSX_IMPORT_ZIP_BUDGET, maxEntries: 2 });
    } catch (err) {
      caught = err as XlsxZipGuardError;
    }
    expect(caught?.reason).toBe('entries');
  });

  it('refuses non-zip bytes as not-zip', () => {
    let caught: XlsxZipGuardError | undefined;
    try {
      scanXlsxZip(Buffer.from('not a zip at all'), XLSX_IMPORT_ZIP_BUDGET);
    } catch (err) {
      caught = err as XlsxZipGuardError;
    }
    expect(caught?.reason).toBe('not-zip');
  });
});
