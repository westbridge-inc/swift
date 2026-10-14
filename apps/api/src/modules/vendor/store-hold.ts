import { AppError } from '../../utils/errors';

/**
 * [NO-DEAD-ENDS · owner, 6 Oct] A store that cannot work orders is told why
 * and what it can still do.
 *
 * Every hold used to answer with one sentence: "Your store is not active and
 * cannot work orders. Reopen it from Account." There is no reopen control in
 * Account (or anywhere): a fee hold clears when the fee is credited, and a
 * suspension Swift placed is lifted only by Swift. So the person was sent to a
 * door that does not exist. The refusal now names the hold, the one thing that
 * lifts it, and what still works (the store can always decline a waiting
 * order; a fee hold still finishes orders already accepted).
 *
 * The apps show `message` verbatim (the store build in review included), and
 * the 403 VENDOR_SUSPENDED contract is unchanged. `details` carries the same
 * facts as data for newer apps.
 */
export type StoreHoldKind = 'FEE_UNPAID' | 'SUSPENDED_BY_SWIFT' | 'OWNER_ACCOUNT_CLOSED' | 'SUSPENDED' | 'CLOSED';
export type StoreHoldNextStep = 'PAY_WEEKLY_FEE' | 'CONTACT_SUPPORT';

export function storeHoldKind(store: { status: string; suspensionSource: string | null }): StoreHoldKind | null {
  if (store.status === 'CLOSED') return 'CLOSED';
  if (store.status !== 'SUSPENDED') return null;
  switch (store.suspensionSource) {
    case 'BILLING': return 'FEE_UNPAID';
    case 'ADMIN': return 'SUSPENDED_BY_SWIFT';
    case 'WIND_DOWN': return 'OWNER_ACCOUNT_CLOSED';
    default: return 'SUSPENDED';
  }
}

const HOLD_COPY: Record<StoreHoldKind, { message: string; nextStep: StoreHoldNextStep }> = {
  FEE_UNPAID: {
    message: 'New orders are paused until the weekly fee is paid, so this order can’t be accepted. You can still finish the orders you already accepted, or decline this one. The owner pays from Weekly fee.',
    nextStep: 'PAY_WEEKLY_FEE',
  },
  SUSPENDED_BY_SWIFT: {
    message: 'Swift has suspended this store, so it can’t work orders. Ask Swift support through Get Help why, and what will restore it. You can still decline orders that are waiting.',
    nextStep: 'CONTACT_SUPPORT',
  },
  OWNER_ACCOUNT_CLOSED: {
    message: 'This store was closed when its owner’s Swift account was closed, so it can’t work orders. You can still decline orders that are waiting. If this is a mistake, ask Swift support through Get Help.',
    nextStep: 'CONTACT_SUPPORT',
  },
  SUSPENDED: {
    message: 'This store is suspended, so it can’t work orders. Ask Swift support through Get Help why, and what will restore it. You can still decline orders that are waiting.',
    nextStep: 'CONTACT_SUPPORT',
  },
  CLOSED: {
    message: 'This store is closed, so it can’t work orders. If it should be open, ask Swift support through Get Help. You can still decline orders that are waiting.',
    nextStep: 'CONTACT_SUPPORT',
  },
};

/** The refusal for a store whose hold blocks this work. */
export function storeHoldRefusal(store: { status: string; suspensionSource: string | null }): AppError {
  const kind = storeHoldKind(store) ?? 'SUSPENDED';
  const { message, nextStep } = HOLD_COPY[kind];
  return new AppError(403, 'VENDOR_SUSPENDED', message, { hold: kind, nextStep, canDecline: true, canFinishAccepted: kind === 'FEE_UNPAID' });
}
