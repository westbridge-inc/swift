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

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++; // doubled quote inside a quoted cell
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }

  // Last cell/row without trailing newline
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // Drop fully-empty rows (blank lines in messy files)
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/** First row is the header; returns objects keyed by trimmed header names. */
export function parseCsvWithHeader(input: string): Array<Record<string, string>> {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((key, i) => {
      record[key] = (cells[i] ?? '').trim();
    });
    return record;
  });
}
