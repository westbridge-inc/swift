import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  /** A width for the fixed layout ("40%", "7rem"); the rest share what is left. */
  width?: string;
  align?: 'left' | 'right';
  /** The row's name: on a phone it leads the card, without a label. */
  primary?: boolean;
  cell: (_row: T) => ReactNode;
}

/**
 * [MISSION CONTROL · PR-1] The list table: fixed column widths so a long name
 * truncates instead of crushing its neighbours, and at phone width (≤ 640 px)
 * every row becomes a card of "label — value" lines, so nothing scrolls
 * sideways at 390 px. Headers stay in the DOM for screen readers.
 */
export function DataTable<T>({ label, columns, rows, rowKey, empty }: {
  /** What the table lists, for screen readers: "Stores", "Recent orders". */
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (_row: T) => string;
  /** What an empty list means, in words ("No orders yet."). Only for a list that LOADED empty. */
  empty: string;
}) {
  return (
    <div className="mc-table-wrap">
      <table className="mc-table" aria-label={label}>
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="mc-label" data-align={c.align === 'right' ? 'right' : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="mc-table-empty">{empty}</td>
            </tr>
          ) : rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-label={c.header}
                  data-primary={c.primary ? '' : undefined}
                  data-align={c.align === 'right' ? 'right' : undefined}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
