/**
 * [L09 · reorder] What the phone says after a reorder that could not bring
 * everything back. The server names the lines left out (sold out, or choices
 * to make again) in its message; the cart alone would hide them, so the phone
 * says so before it opens the cart. A full reorder needs no notice.
 */
export interface ReorderResult {
  unavailableItems?: number | null;
  needsOptions?: string[] | null;
  message?: string | null;
}

export function reorderNotice(result: ReorderResult | null | undefined): { title: string; description: string } | null {
  const leftOut = (result?.unavailableItems ?? 0) > 0 || (result?.needsOptions?.length ?? 0) > 0;
  if (!leftOut) return null;
  return {
    title: 'Some items were not added',
    description: result?.message || 'Some items from this order could not be added. Check your cart.',
  };
}
