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
//
// [SEC-DOS F3] It reads the archive EXACTLY as JSZip 3.10.1 (under exceljs)
// does, or refuses it. JSZip takes the LAST end record from the end of the
// file, shifts every offset when bytes were prepended, walks the central
// directory for as long as the signature matches (whatever count the end
// record claims), and names each entry from its LOCAL header. So this guard
// requires: the end record is the last signature and ends the file exactly;
// the directory ends exactly at the end record (nothing prepended, nothing
// between); exactly the counted entries, at least one, fill it; no two entries
// share or overlap local data or the directory; local and directory names,
// methods and sizes agree; no encryption.
// Then it hands exceljs NOT the upload but a rebuilt archive of exactly the
// bytes it measured, every entry stored: there is nothing left to inflate.
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
/** General-purpose flag bit 0: encrypted. JSZip refuses it. */
const ENCRYPTED_FLAG = 0x0001;
/** General-purpose flag bit 11: the name is UTF-8. Kept in the rebuilt archive. */
const UTF8_NAME_FLAG = 0x0800;

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
  /** [SEC-DOS F3] The archive to hand exceljs: rebuilt from exactly the bytes measured here, every entry STORED. */
  archive: Buffer;
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
    || buffer.readUInt16LE(eocd + 4) === 0xffff
    || buffer.readUInt16LE(eocd + 6) === 0xffff
  ) {
    throw new XlsxZipGuardError('zip64', 'ZIP64 archives are not supported for menu imports.');
  }
  if (entriesOnDisk !== totalEntries || buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    throw new XlsxZipGuardError('multi-disk', 'Multi-disk ZIP archives are not supported for menu imports.');
  }
  // [SEC-DOS F3] The end record ends the file exactly: nothing after its comment.
  if (eocd + EOCD_FIXED_SIZE + buffer.readUInt16LE(eocd + 20) !== buffer.length) {
    throw new XlsxZipGuardError('malformed', 'The ZIP end record does not end the file.');
  }
  if (totalEntries === 0) {
    throw new XlsxZipGuardError('malformed', 'The ZIP archive has no entries.');
  }
  if (totalEntries > budget.maxEntries) {
    throw new XlsxZipGuardError('entries', `Too many entries (${totalEntries} > ${budget.maxEntries}).`);
  }
  // [SEC-DOS F3] The directory ends exactly where the end record starts. JSZip
  // shifts every offset by any difference (prepended bytes), so a difference
  // would make it read other bytes than these.
  if (cdOffset + cdSize !== eocd) {
    throw new XlsxZipGuardError('malformed', 'The ZIP central directory does not end at the end record.');
  }

  const end = eocd;
  let pos = cdOffset;
  let totalUncompressed = 0;
  let maxEntryUncompressed = 0;
  const located: Array<{ flags: number; method: number; time: number; date: number; compressed: number; uncompressed: number; localOffset: number; name: Buffer }> = [];
  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + CENTRAL_ENTRY_FIXED_SIZE > end || buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new XlsxZipGuardError('malformed', 'The ZIP central directory is malformed.');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      throw new XlsxZipGuardError('zip64', 'ZIP64 entries are not supported for menu imports.');
    }
    if (flags & ENCRYPTED_FLAG) {
      throw new XlsxZipGuardError('malformed', 'Encrypted ZIP entries are not supported for menu imports.');
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
    located.push({
      flags, method, time: buffer.readUInt16LE(pos + 12), date: buffer.readUInt16LE(pos + 14),
      compressed, uncompressed, localOffset, name: buffer.subarray(pos + CENTRAL_ENTRY_FIXED_SIZE, pos + CENTRAL_ENTRY_FIXED_SIZE + nameLen),
    });
    pos += entrySize;
  }
  // [SEC-DOS F3] Exactly the counted entries fill the directory: JSZip keeps
  // reading records while the signature matches, so any byte left over could
  // be a record this guard never measured.
  if (pos !== end) {
    throw new XlsxZipGuardError('malformed', 'The ZIP central directory holds more than its end record counts.');
  }

  // The ADVERTISED sizes above are only what the directory claims. A crafted
  // archive can declare a tiny size while its deflate stream expands a
  // thousand-fold, and JSZip (under exceljs) inflates the real stream, not
  // the claim. So every entry is also inflated here with a hard output cap,
  // and must inflate to exactly the size it declares: a lie is refused before
  // exceljs sees the file. The work is bounded by the same budget.
  let inflatedTotal = 0;
  const measured: Buffer[] = [];
  const spans: Array<[number, number]> = [];
  for (const entry of located) {
    const lh = entry.localOffset;
    if (lh + LOCAL_HEADER_FIXED_SIZE > cdOffset || buffer.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
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
    // [SEC-DOS F3] JSZip names the entry from the LOCAL header: it must be the directory's name.
    const localNameLen = buffer.readUInt16LE(lh + 26);
    const nameStart = lh + LOCAL_HEADER_FIXED_SIZE;
    if (localNameLen !== entry.name.length || nameStart + localNameLen > cdOffset || !buffer.subarray(nameStart, nameStart + localNameLen).equals(entry.name)) {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry local name disagrees with its directory entry.');
    }
    const dataStart = nameStart + localNameLen + buffer.readUInt16LE(lh + 28);
    const dataEnd = dataStart + entry.compressed;
    // [SEC-DOS F3] Local data lies wholly before the directory.
    if (dataEnd > cdOffset) {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry is truncated.');
    }
    spans.push([lh, dataEnd]);
    let content: Buffer;
    if (entry.method === METHOD_STORED) {
      content = buffer.subarray(dataStart, dataEnd);
    } else if (entry.method === METHOD_DEFLATE) {
      try {
        content = inflateRawSync(buffer.subarray(dataStart, dataEnd), { maxOutputLength: budget.maxEntryUncompressed });
      } catch {
        throw new XlsxZipGuardError('inflated-size', `An entry inflates past ${budget.maxEntryUncompressed} bytes or is corrupt.`);
      }
    } else {
      throw new XlsxZipGuardError('malformed', 'A ZIP entry uses an unsupported compression method.');
    }
    if (content.length !== entry.uncompressed) {
      throw new XlsxZipGuardError('inflated-size', 'A ZIP entry inflates to a different size than it declares.');
    }
    inflatedTotal += content.length;
    if (inflatedTotal > budget.maxTotalUncompressed) {
      throw new XlsxZipGuardError('total-size', `The archive inflates past ${budget.maxTotalUncompressed} bytes.`);
    }
    measured.push(content);
  }
  // [SEC-DOS F3] No two entries share or overlap local data.
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i]![0] < spans[i - 1]![1]) {
      throw new XlsxZipGuardError('malformed', 'Two ZIP entries share or overlap their data.');
    }
  }
  return {
    entries: totalEntries,
    totalUncompressed,
    maxEntryUncompressed,
    archive: storedArchive(located.map((entry, i) => ({ ...entry, content: measured[i]! }))),
  };
}

/**
 * [SEC-DOS F3] A plain ZIP of these entries, every one STORED, in order, with
 * no extra fields or comments: what exceljs is given instead of the upload.
 * Only the UTF-8 name flag and the time are carried over; the checksum is
 * computed from the measured bytes.
 */
function storedArchive(entries: Array<{ flags: number; time: number; date: number; name: Buffer; content: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const flags = entry.flags & UTF8_NAME_FLAG;
    const crc = crc32(entry.content);
    const local = Buffer.alloc(LOCAL_HEADER_FIXED_SIZE);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(entry.time, 10);
    local.writeUInt16LE(entry.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    const central = Buffer.alloc(CENTRAL_ENTRY_FIXED_SIZE);
    central.writeUInt32LE(CENTRAL_DIR_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(METHOD_STORED, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, entry.name, entry.content);
    centrals.push(central, entry.name);
    offset += LOCAL_HEADER_FIXED_SIZE + entry.name.length + entry.content.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(EOCD_FIXED_SIZE);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ZIP's), for the rebuilt archive's entries. */
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Locate the End of Central Directory record as JSZip does: the LAST
 *  signature in the file, searched from four bytes before the end. One that
 *  leaves no room for the record, or sits further back than any comment could
 *  reach, is refused. */
function findEocd(buffer: Buffer): number {
  for (let i = buffer.length - 4; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
    if (i + EOCD_FIXED_SIZE > buffer.length || buffer.length - i - EOCD_FIXED_SIZE > MAX_EOCD_COMMENT) {
      throw new XlsxZipGuardError('malformed', 'The ZIP end record is malformed.');
    }
    return i;
  }
  throw new XlsxZipGuardError('not-zip', 'The file is not a ZIP archive.');
}
