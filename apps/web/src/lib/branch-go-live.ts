// [CHAINS PR2 · REVIEW-F #2220 S3-1] A store not live yet: the owner's steps, from the server's `goLive`, and where
// each is done on the website. Only the Branches page loads this (the shared lib/branches stays inside every branch
// page's first-load ceiling).
import { isAwaitingApproval, waitingFor, type StoreGoLive } from './branch-label';

/** An owner's step before a store goes live: what it is, and where it is done on the website (`settings`: the store's
 *  own Settings page) or, for documents, in the Swift app. */
export const GO_LIVE_STEPS: Readonly<Record<string, { words: string; where: 'settings' | 'app' }>> = {
  DOCUMENTS: { words: 'Add the documents it still needs, in the Swift app under Documents', where: 'app' },
  PUBLISHED_PHONE: { words: 'Add the number customers can call', where: 'settings' },
  FOOD_HANDLERS: { words: 'Confirm your food handlers', where: 'settings' },
  // [RETIER PR-A2] the store's fee follows its catalogue above the first step: its owner reads and ticks it
  WEEKLY_FEE: { words: 'Read and tick its weekly fee', where: 'settings' },
};

/** The owner's steps for a store not live yet (none on Swift's turn; unknown steps are left out). */
export function ownerSteps(store: { goLive?: StoreGoLive | null; awaitingApproval?: boolean; status?: string }): Array<{ words: string; where: 'settings' | 'app' }> {
  if (waitingFor(store) !== 'OWNER' || !isAwaitingApproval(store)) return [];
  return (store.goLive?.steps ?? []).flatMap((step) => (GO_LIVE_STEPS[step] ? [GO_LIVE_STEPS[step]!] : []));
}
