// [CHAINS PR2] The switcher's label, kept dependency-free: the dashboard shell (every console page's first load)
// imports only this, never lib/branches.
//
// [REVIEW-F #2220 S3-1] A store not live yet is "waiting for Swift's approval" ONLY when the server says nothing is
// owed by its owner (`goLive.waitingFor` 'SWIFT'). On the owner's turn it is "not live yet: finish setting it up";
// with no word from the server, plain "not live yet".

export const WAITING_FOR_APPROVAL = 'waiting for Swift’s approval';
export const FINISH_SETTING_UP = 'not live yet: finish setting it up';
export const NOT_LIVE_YET = 'not live yet';

/** The server's word on a store not live yet: whose turn it is, and the owner's steps still to do. */
export interface StoreGoLive { waitingFor: 'OWNER' | 'SWIFT'; steps: string[] }
type Labelled = { name: string; awaitingApproval?: boolean; status?: string; goLive?: StoreGoLive | null };

/** Whose turn it is for a store not live yet, read strictly (an unknown answer is no answer). */
export function waitingFor(store: { goLive?: StoreGoLive | null }): 'OWNER' | 'SWIFT' | null {
  const w = store.goLive?.waitingFor;
  return w === 'OWNER' || w === 'SWIFT' ? w : null;
}

/** The name a store goes by in a list, with whose turn it is while it is not live. */
export function branchLabel(store: Labelled): string {
  if (!isAwaitingApproval(store)) return store.name;
  const w = waitingFor(store);
  return `${store.name} · ${w === 'SWIFT' ? WAITING_FOR_APPROVAL : w === 'OWNER' ? FINISH_SETTING_UP : NOT_LIVE_YET}`;
}

/** A store not live yet (whoever's turn it is). */
export function isAwaitingApproval(store: { awaitingApproval?: boolean; status?: string }): boolean {
  return store.awaitingApproval === true || store.status === 'PENDING_APPROVAL';
}
