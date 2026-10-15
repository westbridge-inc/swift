/**
 * [L09 · M026] The choices a customer made for one order line, as the store
 * reads them while making it: "Size: Large · Extras: Cheese". The server sends
 * each line's snapshotted options (group, choice, price) on the order board
 * and the order detail; a line with none shows nothing.
 */
export interface OrderLineOption {
  group?: string | null;
  name?: string | null;
}

export function orderLineOptionsText(options: readonly OrderLineOption[] | null | undefined): string | null {
  const parts = (options ?? [])
    .filter((o) => o?.name)
    .map((o) => (o.group ? `${o.group}: ${o.name}` : String(o.name)));
  return parts.length ? parts.join(' · ') : null;
}
