/** A store selection as a notification or an operation captured it. */
export interface StoreSelection {
  selectedStoreId: string | null;
  storeGeneration: number;
}

/** `now` is still the captured selection, or moved only by the shell's
 *  automatic null → first-store handoff: never an explicit choice or a round
 *  trip. One law for the tap-router and the fee notice it resolves. */
export function selectionStillCurrent(
  captured: StoreSelection,
  now: StoreSelection & { initialSelectionGeneration?: number | null },
): boolean {
  if (now.selectedStoreId === captured.selectedStoreId && now.storeGeneration === captured.storeGeneration) return true;
  return captured.selectedStoreId === null
    && now.initialSelectionGeneration === now.storeGeneration
    && now.storeGeneration === captured.storeGeneration + 1;
}
