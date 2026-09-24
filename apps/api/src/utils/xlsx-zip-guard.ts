// ---------------------------------------------------------------------------
// ZIP central-directory pre-scan for the Excel menu import (audit DS107 High
// #5). exceljs inflates a workbook with JSZip, so a small .xlsx whose central
// directory *advertises* a multi-GB entry would be inflated in memory before
// any header/row validation could refuse it. This scanner walks only the
// central directory — a few bytes of pointer math per entry, never the
// payload — and sums the advertised uncompressed sizes, so a bomb is refused
// before the first byte is inflated. Hand-rolled because jszip/yauzl are not
// direct dependencies of apps/api (installing them needs a network the deploy
// pipeline may not have), and a real catalogue workbook stays far below every
// bound below.
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50; // End of Central Directory
const CENTRAL_DIR_SIGNATURE = 0x02014b50; // Central directory file header
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
    public readonly reason: 'not-zip' | 'zip64' | 'multi-disk' | 'malformed' | 'entries' | 'entry-size' | 'total-size',
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

/** Sum the ZIP's advertised uncompressed sizes without inflating anything.
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
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + CENTRAL_ENTRY_FIXED_SIZE > end || buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new XlsxZipGuardError('malformed', 'The ZIP central directory is malformed.');
    }
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
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
    pos += entrySize;
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
