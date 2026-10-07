'use client';

import { useEffect, useId, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { rangeText, type ListState, type PageMeta } from '@/lib/list-query';

export interface FilterSpec {
  key: string;
  label: string;
  /** [value, words] — the first entry is "All". */
  options: Array<[string, string]>;
}

/** Search as the operator types (debounced), filters, and the test-data switch. Any change goes back to page 1. */
export function ListToolbar({ state, onChange, searchLabel, filters = [] }: {
  state: ListState;
  onChange: (_next: ListState) => void;
  searchLabel: string;
  filters?: FilterSpec[];
}) {
  const uid = useId();
  const [text, setText] = useState(state.search);
  useEffect(() => {
    const t = setTimeout(() => { if (text !== state.search) onChange({ ...state, search: text, page: 1 }); }, 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps -- debounce on the typed text only

  return (
    <div className="mc-toolbar" role="search">
      <div className="mc-toolbar-search">
        <Search size={16} aria-hidden="true" />
        <label htmlFor={`${uid}-search`} className="sr-only">{searchLabel}</label>
        <input id={`${uid}-search`} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={searchLabel} />
      </div>
      {filters.map((f) => (
        <div key={f.key} className="mc-toolbar-filter">
          <label htmlFor={`${uid}-${f.key}`} className="mc-label">{f.label}</label>
          <select
            id={`${uid}-${f.key}`}
            value={state.filters[f.key] ?? ''}
            onChange={(e) => onChange({ ...state, filters: { ...state.filters, [f.key]: e.target.value }, page: 1 })}
          >
            {f.options.map(([value, words]) => <option key={value} value={value}>{words}</option>)}
          </select>
        </div>
      ))}
      <label className="mc-toolbar-check" htmlFor={`${uid}-test`}>
        <input
          id={`${uid}-test`}
          type="checkbox"
          checked={state.showTestData}
          onChange={(e) => onChange({ ...state, showTestData: e.target.checked, page: 1 })}
        />
        Show test data
      </label>
    </div>
  );
}

/**
 * Previous / page n of m / Next, from the server's own page meta — and, while
 * test data is hidden, how many test records the server left out, with a way
 * to show them, so nothing leaves the list without a count.
 */
export function Pager({ meta, shown, onPage, onShowTestData }: {
  meta: PageMeta | undefined;
  shown: number;
  onPage: (_page: number) => void;
  onShowTestData?: () => void;
}) {
  if (!meta) return null;
  const hidden = meta.hiddenTestRecords ?? 0;
  return (
    <nav className="mc-pager" aria-label="Pages">
      <p className="mc-muted" aria-live="polite">
        {rangeText(meta, shown)}
        {hidden > 0 ? (
          <>
            {' · '}{hidden.toLocaleString('en-GY')} test record{hidden === 1 ? '' : 's'} hidden
            {onShowTestData ? <>{' '}<button type="button" className="mc-link-button" onClick={onShowTestData}>Show them</button></> : null}
          </>
        ) : null}
      </p>
      {meta.totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <button type="button" className="mc-btn" disabled={!meta.hasPrev} onClick={() => onPage(meta.page - 1)}>
            <ChevronLeft size={16} aria-hidden="true" /> Previous
          </button>
          <span className="mc-numbers mc-muted text-xs">Page {meta.page} of {meta.totalPages}</span>
          <button type="button" className="mc-btn" disabled={!meta.hasNext} onClick={() => onPage(meta.page + 1)}>
            Next <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </nav>
  );
}
