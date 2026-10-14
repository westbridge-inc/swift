/**
 * [W6] A store's one address, worked out from what a link carried. Pure: the
 * old-address redirect imports it without pulling the store page's script.
 */
export type StoreQuery = Record<string, string | string[] | undefined>;

/** The item a link opens the store at (`?item=`), when it can be an item id. */
export function requestedItem(query: StoreQuery): string | undefined {
  const item = query['item'];
  return typeof item === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item) ? item : undefined;
}

/**
 * The store's one address, carrying only what the page itself reads from the
 * query: a scanned code's attribution (`src=qr`, `c`, `t`) and the item to
 * open. Anything else in the query (a `next=`, tracking, junk) is dropped.
 */
export function canonicalStorePath(slug: string, searchParams: StoreQuery): string {
  const query = new URLSearchParams();
  const src = searchParams['src'];
  const code = searchParams['c'];
  const template = searchParams['t'];
  if (src === 'qr') query.set('src', src);
  if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(code)) query.set('c', code);
  if (typeof template === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(template)) query.set('t', template);
  const item = requestedItem(searchParams);
  if (item) query.set('item', item);
  const suffix = query.toString();
  return `/store/${encodeURIComponent(slug)}${suffix ? `?${suffix}` : ''}`;
}
