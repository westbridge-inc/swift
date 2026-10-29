// [CHAINS PR2] The switcher's label, kept dependency-free: the dashboard shell (every console page's first load)
// imports only this, never lib/branches.

export const WAITING_FOR_APPROVAL = 'waiting for Swift’s approval';

/** The name a store goes by in a list: "<name> · waiting for Swift's approval" while Swift has not approved it. */
export function branchLabel(store: { name: string; awaitingApproval?: boolean; status?: string }): string {
  return isAwaitingApproval(store) ? `${store.name} · ${WAITING_FOR_APPROVAL}` : store.name;
}

export function isAwaitingApproval(store: { awaitingApproval?: boolean; status?: string }): boolean {
  return store.awaitingApproval === true || store.status === 'PENDING_APPROVAL';
}
