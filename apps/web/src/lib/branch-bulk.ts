// [CHAINS PR2 · owner 29 Oct 2026] Bulk actions on the Branches page (pause or take orders, copy hours) run one store
// at a time over each store's own route, so every store's own checks apply; the result names each store that
// refused, with the server's words. (Split from lib/branches for the page size budget, CI perf #2220.)

export interface BranchOutcome { storeId: string; ok: boolean; message?: string }

/** Run `act` for each store, one after another (never two writes at once), and say how each went. */
export async function forEachBranch(storeIds: readonly string[], act: (_storeId: string) => Promise<unknown>): Promise<BranchOutcome[]> {
  const out: BranchOutcome[] = [];
  for (const storeId of storeIds) {
    try {
      await act(storeId);
      out.push({ storeId, ok: true });
    } catch (e) {
      out.push({ storeId, ok: false, message: e instanceof Error && e.message ? e.message : 'That didn’t go through. Try again.' });
    }
  }
  return out;
}

/** "Done for 3 branches." / "Done for 2 of 3 branches. Not done: Camp Street: <the server's words>" */
export function branchOutcomeWords(outcomes: readonly BranchOutcome[], nameOf: (_storeId: string) => string): string {
  const done = outcomes.filter((o) => o.ok).length;
  const plural = (n: number) => `${n} ${n === 1 ? 'branch' : 'branches'}`;
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return `Done for ${plural(done)}.`;
  const why = failed.map((o) => `${nameOf(o.storeId)}: ${o.message ?? 'not done'}`).join(' · ');
  return `Done for ${done} of ${plural(outcomes.length)}. Not done: ${why}`;
}
