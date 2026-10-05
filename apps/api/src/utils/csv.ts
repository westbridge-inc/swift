import { AppError } from './errors';

/**
 * Minimal RFC-4180-ish CSV parsing for catalogue imports: quoted fields,
 * embedded commas/newlines, doubled quotes, CRLF, and a trailing newline.
 * Returns rows of raw string cells — validation happens per-row with zod.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let parsedCells = 0;
  const finishCell = () => {
    if (row.length >= 100) throw new AppError(400, 'CSV_TOO_WIDE', 'CSV is limited to 100 columns');
    if (++parsedCells > 500_100) throw new AppError(400, 'CSV_TOO_MANY_CELLS', 'CSV exceeds the parsed cells budget');
    row.push(cell);
    cell = '';
  };
  const finishRow = () => {
    finishCell();
    if (row.some((value) => value.trim().length > 0)) {
      // Header plus 5000 data rows. Refuse before retaining or expanding another row.
      if (rows.length >= 5001) throw new AppError(400, 'TOO_MANY_ROWS', 'Import is limited to 5000 rows per file');
      rows.push(row);
    }
    row = [];
  };
  const append = (char: string) => {
    if (cell.length >= 2048) throw new AppError(400, 'CSV_CELL_TOO_LONG', 'CSV fields are limited to 2048 characters');
    cell += char;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          append('"');
          i++; // doubled quote inside a quoted cell
        } else {
          inQuotes = false;
        }
      } else {
        append(char);
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      finishCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      finishRow();
    } else {
      append(char);
    }
  }

  // Last cell/row without trailing newline
  if (cell.length > 0 || row.length > 0) {
    finishRow();
  }

  // Drop fully-empty rows (blank lines in messy files)
  return rows;
}

/** First row is the header; returns objects keyed by trimmed header names. */
export function parseCsvWithHeader(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = Object.create(null) as Record<string, string>;
    header.forEach((key, i) => {
      record[key] = (cells[i] ?? '').trim();
    });
    return record;
  });
}
