// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] What a list asks the server for.
//
// Every admin list pages, searches and filters ON THE SERVER (the routes have
// supported it all along; the console asked for page 1 of 20 and nothing
// else), and test data is hidden there too (`excludeFixtures`), so the pager's
// "of 312" is the server's count of exactly what can be shown.
// ---------------------------------------------------------------------------

export const LIST_PAGE_SIZE = 25;

export interface ListState {
  page: number;
  search: string;
  filters: Record<string, string>;
  /** Off by default: the journey suite's TEST- stores and +5920 people stay out. */
  showTestData: boolean;
}

export const EMPTY_LIST_STATE: ListState = { page: 1, search: '', filters: {}, showTestData: false };

export function listQueryString(state: ListState, limit = LIST_PAGE_SIZE): string {
  const q = new URLSearchParams();
  q.set('page', String(state.page));
  q.set('limit', String(limit));
  const search = state.search.trim();
  if (search) q.set('search', search);
  for (const [key, value] of Object.entries(state.filters)) if (value) q.set(key, value);
  // The server hides test data only when asked; the console asks unless "Show test data" is ticked.
  if (!state.showTestData) q.set('excludeFixtures', 'true');
  return q.toString();
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  /** How many test records the server left out of this list (only while they are hidden). */
  hiddenTestRecords?: number;
}

/** "Showing 26–50 of 312", or the honest empty line. */
export function rangeText(meta: PageMeta | undefined, shown: number): string {
  if (!meta) return '';
  if (meta.total === 0) return 'Nothing matches.';
  if (shown === 0) return `No records on this page. ${meta.total.toLocaleString('en-GY')} matching records.`;
  const from = (meta.page - 1) * meta.limit + 1;
  return `Showing ${from.toLocaleString('en-GY')}–${(from + shown - 1).toLocaleString('en-GY')} of ${meta.total.toLocaleString('en-GY')}`;
}
