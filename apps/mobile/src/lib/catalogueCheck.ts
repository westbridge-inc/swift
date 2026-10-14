/**
 * [GUARDRAILS §8] What a partner reads about an item Swift hides (owner, 13 Oct 2026).
 *
 * Swift never carries alcohol, tobacco, vapes, 18+ items, medicines, cooking gas
 * or fuel. The server judges every item: a banned category or a person's removal
 * is NOT ALLOWED; a banned word in the partner's own text holds the item until a
 * person checks it ("Waiting for a quick check"). The server writes the message;
 * this only adds what happens next, so the words stay the owner's.
 */
export type CatalogueCheck =
  | { status: 'NOT_ALLOWED'; message: string; prohibitedClass?: string; reason?: string | null }
  | { status: 'WAITING_FOR_CHECK'; message: string; prohibitedClass?: string; field?: string; term?: string };

/** The line under an item on the partner's menu, or null when there is nothing to say. */
export function catalogueCheckLine(check: CatalogueCheck | null | undefined): string | null {
  if (!check || typeof check.message !== 'string' || !check.message) return null;
  if (check.status === 'NOT_ALLOWED') return check.reason ? `${check.message} Reason: ${check.reason}` : check.message;
  if (check.status === 'WAITING_FOR_CHECK') return `${check.message} — hidden from customers until Swift checks it.`;
  return null;
}

/** The import summary's tail: how many imported rows a banned word is holding. Older servers send nothing. */
export function importCheckSummary(result: { waitingForCheckCount?: number } | null | undefined): string {
  const n = result?.waitingForCheckCount ?? 0;
  return n > 0 ? ` · ${n} waiting for a quick check` : '';
}
