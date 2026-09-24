// ---------------------------------------------------------------------------
// ZIP central-directory pre-scan for the Excel menu import (audit DS107 High
// #5). exceljs inflates a workbook with JSZip, so a small .xlsx whose central
// directory *advertises* a multi-GB entry would be inflated in memory before
// any header/row validation could refuse it. This scanner first walks the
// central directory (pointer math only) and refuses an archive whose
// ADVERTISED sizes break the budget; then it inflates each entry itself with a
// hard output cap and refuses one whose real size differs from its claim, so a
// lying directory cannot smuggle a bomb past the first pass. Hand-rolled because jszip/yauzl are not
// direct dependencies of apps/api (installing them needs a network the deploy
// pipeline may not have), and a real catalogue workbook stays far below every
// bound below.
// ---------------------------------------------------------------------------

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50; // End of Central Directory
const CENTRAL_DIR_SIGNATURE = 0x02014b50; // Central directory file header
const LOCAL_HEADER_SIGNATURE = 0x04034b50; // Local file header
const LOCAL_HEADER_FIXED_SIZE = 30;
/** General-purpose flag bit 3: sizes live in a data descriptor after the data. */
const DATA_DESCRIPTOR_FLAG = 0x0008;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const EOCD_FIXED_SIZE = 22;
const CENTRAL_ENTRY_FIXED_SIZE = 46;
const MAX_EOCD_COMMENT = 0xffff; // ZIP spec §4.3.16

export interface XlsxZipBudget {
  /** Total advertised uncompressed bytes across all entries. */
  maxTotalUncompressed: number;
  /** Advertised uncompressed bytes of any single entry. */
  maxEntryUncompressed: number;
  /** Number of central-directory entries. */
  maxEntries: number;
}

export interface XlsxZipScan {
  entries: number;
  totalUncompressed: number;
  maxEntryUncompressed: number;
}

export class XlsxZipGuardError extends Error {
  constructor(
    public readonly reason: 'not-zip' | 'zip64' | 'multi-disk' | 'malformed' | 'entries' | 'entry-size' | 'total-size' | 'inflated-size',
    message: string,
  ) {
    super(message);
    this.name = 'XlsxZipGuardError';
  }
}

/** The import budget: a real catalogue workbook stays far under this; the
 *  numbers bound what exceljs may ever be asked to inflate. */
export const XLSX_IMPORT_ZIP_BUDGET: XlsxZipBudget = {
  maxTotalUncompressed: 30 * 1024 * 1024, // 30 MB total
  maxEntryUncompressed: 10 * 1024 * 1024, // 10 MB per entry
  maxEntries: 2000, // a workbook has ~12–50 entries; media-heavy ones < 100
};

/** Check the ZIP's advertised sizes against the budget, then inflate each
 *  entry under a hard cap and require its real size to equal its claim.
 *  Throws XlsxZipGuardError on the first budget/structure violation. */
export function scanXlsxZip(buffer: Buffer, budget: XlsxZipBudget): XlsxZipScan {
  const eocd = findEocd(buffer);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  // ZIP64 is never legitimate inside the 1 MB upload cap: the 32-bit sentinels
  // mean the real sizes live in a zip64 extra field this scanner does not
  // parse, so refuse rather than trust an unvalidated value.
  if (
    entriesOnDisk === 0xffff
    || totalEntries === 0xffff
    || cdSize === 0xffffffff
    || cdOffset === 0xffffffff
  ) {
    throw new XlsxZipGuardError('zip64', 'ZIP64 archives are not supported for menu imports.');
  }
  if (entriesOnDisk !== totalEntries) {
    throw new XlsxZipGuardError('multi-disk', 'Multi-disk ZIP archives are not supported for menu imports.');
  }
  if (totalEntries > budget.maxEntries) {
    throw new XlsxZipGuardError('entries', `Too many entries (${totalEntries} > ${budget.maxEntries}).`);
  }
  if (cdOffset + cdSize > buffer.length) {
    throw new XlsxZipGuardError('malformed', 'The ZIP central directory is truncated.');
  }

  const end = cdOffset + cdSize;
  let pos = cdOffset;
  let totalUncompressed = 0;
  let maxEntryUncompressed = 0;
  const located: Array<{ method: number; compressed: number; uncompressed: number; localOffset: number }> = [];
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + CENTRAL_ENTRY_FIXED_SIZE > end || buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new XlsxZipGuardError('malformed', 'The ZIP central directory is malformed.');
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new XlsxZipGuardError('zip64', 'ZIP64 entries are not supported for menu imports.');
    }
    totalUncompressed += uncompressed;
    if (uncompressed > maxEntryUncompressed) maxEntryUncompressed = uncompressed;
    if (uncompressed > budget.maxEntryUncompressed) {
      throw new XlsxZipGuardError(
        'entry-size',
        `An entry declares ${uncompressed} uncompressed bytes (limit ${budget.maxEntryUncompressed}).`,
      );
    }
    if (totalUncompressed > budget.maxTotalUncompressed) {
      throw new XlsxZipGuardError(
        'total-size',
        `The archive declares ${totalUncompressed} uncompressed bytes (limit ${budget.maxTotalUncompressed}).`,
      );
    }
    const entrySize = CENTRAL_ENTRY_FIXED_SIZE + nameLen + extraLen + commentLen;
    if (pos + entrySize > end) {
      throw new XlsxZipGuardError('malformed', 'The ZIP central directory is malformed.');
    }
    located.push({ method, compressed, uncompressed, localOffset });
    pos += entrySize;
  }

  // The ADVERTISED sizes above are only what the directory claims. A crafted
  // archive can declare a tiny size while its deflate stream expands a
  // thousand-fold, and JSZip (under exceljs) inflates the real stream, not
  // the claim. So every entry is also inflated here with a hard output cap,
  // and must inflate to exactly the size it declares: a lie is refused before
  // exceljs sees the file. The work is bounded by the same budget.
  let inflatedTotal = 0;
  for (const entry of located) {
    const lh = entry.localOffset;
    if (lh + LOCAL_HEADER_FIXED_SIZE > buffer.length || buffer.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry points outside the archive.');
    }
    // [DS205] The local header must agree with the directory. JSZip 3.10.1
    // (under exceljs) extracts with the DIRECTORY method and sizes and skips
    // these local fields (zipEntry.readLocalPart), so this pass measures what
    // JSZip will inflate. An extractor that believed the local header instead
    // would inflate a different stream than the one measured here, so an
    // archive whose two headers disagree is refused outright: the guard never
    // depends on which header an extractor trusts. Real workbooks agree; with
    // a data descriptor (flag bit 3) the local sizes are legitimately zero, so
    // only the method is compared then.
    const localFlags = buffer.readUInt16LE(lh + 6);
    if (
      buffer.readUInt16LE(lh + 8) !== entry.method
      || ((localFlags & DATA_DESCRIPTOR_FLAG) === 0
        && (buffer.readUInt32LE(lh + 18) !== entry.compressed || buffer.readUInt32LE(lh + 22) !== entry.uncompressed))
    ) {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry local header disagrees with its directory entry.');
    }
    const dataStart = lh + LOCAL_HEADER_FIXED_SIZE + buffer.readUInt16LE(lh + 26) + buffer.readUInt16LE(lh + 28);
    const dataEnd = dataStart + entry.compressed;
    if (dataEnd > buffer.length) {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry is truncated.');
    }
    let actual: number;
    if (entry.method === METHOD_STORED) {
      actual = entry.compressed;
    } else if (entry.method === METHOD_DEFLATE) {
      try {
        actual = inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: budget.maxEntryUncompressed }).length;
      } catch {
        throw new XlsxZipGuardError('inflated-size', `An entry inflates past ${budget.maxEntryUncompressed} bytes or is corrupt.`);
      }
    } else {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry uses an unsupported compression method.');
    }
    if (actual !== entry.uncompressed) {
      throw new XlsxZipGuardError('inflated-size', 'A ZIP entry inflates to a different size than it declares.');
    }
    inflatedTotal += actual;
    if (inflatedTotal > budget.maxTotalUncompressed) {
      throw new XlsxZipGuardError('total-size', `The archive inflates past ${budget.maxTotalUncompressed} bytes.`);
    }
  }
  return { entries: totalEntries, totalUncompressed, maxEntryUncompressed };
}

/** Locate the End of Central Directory record, tolerating a trailing comment. */
function findEocd(buffer: Buffer): number {
  const searchStart = Math.max(0, buffer.length - MAX_EOCD_COMMENT - EOCD_FIXED_SIZE);
  for (let i = buffer.length - EOCD_FIXED_SIZE; i >= searchStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new XlsxZipGuardError('not-zip', 'The file is not a ZIP archive.');
}
