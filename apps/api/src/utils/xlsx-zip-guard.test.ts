import { describe, it, expect } from 'vitest';
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
