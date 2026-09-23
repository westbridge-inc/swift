// ---------------------------------------------------------------------------
// [ORDER-SPINE S1-6] What the customer is told about a direct-MMG payment, and
// what they can say about it.
//
// Swift holds none of this money: the customer pays the store's own wallet and
// the store says whether it arrived. The server records the customer's own
// words beside the store's through one locked claim authority, and holds the
// order when the two disagree. This module turns the server's `mmgClaim`
// projection into the card the order screen shows. Pure — no react-native —
// so every state is unit-tested directly.
// ---------------------------------------------------------------------------

export type CustomerMmgClaim = 'UNRECORDED' | 'PAID' | 'NOT_PAID';
export type MmgClaimResolution = 'CUSTOMER_PAID' | 'CUSTOMER_DID_NOT_PAY';

/** The server's projection (GET /customer/orders/:id → data.mmgClaim). */
export interface MmgClaimView {
  customerClaim: CustomerMmgClaim;
  customerClaimAt: string | null;
  storeClaimed: boolean;
  providerCaptured: boolean;
  disputed: boolean;
  disputedAt: string | null;
  resolution: MmgClaimResolution | null;
  resolvedAt: string | null;
  attemptRejected: boolean;
  revision: number;
  canClaim: boolean;
}

const CLAIMS: readonly string[] = ['UNRECORDED', 'PAID', 'NOT_PAID'];
const RESOLUTIONS: readonly string[] = ['CUSTOMER_PAID', 'CUSTOMER_DID_NOT_PAY'];
const FLAGS = ['storeClaimed', 'providerCaptured', 'disputed', 'attemptRejected', 'canClaim'] as const;
const TIMES = ['customerClaimAt', 'disputedAt', 'resolvedAt'] as const;

/** Strict: anything malformed renders NO claim control rather than a guess. */
export function parseMmgClaimView(raw: unknown): MmgClaimView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['customerClaim'] !== 'string' || !CLAIMS.includes(r['customerClaim'])) return null;
  if (!(r['resolution'] === null || (typeof r['resolution'] === 'string' && RESOLUTIONS.includes(r['resolution'])))) return null;
  for (const flag of FLAGS) if (typeof r[flag] !== 'boolean') return null;
  for (const time of TIMES) if (!(r[time] === null || typeof r[time] === 'string')) return null;
  const revision = r['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  return {
    customerClaim: r['customerClaim'] as CustomerMmgClaim,
    customerClaimAt: r['customerClaimAt'] as string | null,
    storeClaimed: r['storeClaimed'] as boolean,
    providerCaptured: r['providerCaptured'] as boolean,
    disputed: r['disputed'] as boolean,
    disputedAt: r['disputedAt'] as string | null,
    resolution: r['resolution'] as MmgClaimResolution | null,
    resolvedAt: r['resolvedAt'] as string | null,
    attemptRejected: r['attemptRejected'] as boolean,
    revision,
    canClaim: r['canClaim'] as boolean,
  };
}

export type MmgClaimTone = 'neutral' | 'warning' | 'success';

export interface MmgClaimAction {
  /** What the customer is telling Swift. */
  paid: boolean;
  label: string;
  /** A statement that can pause the order is confirmed before it is sent. */
  confirm: { title: string; body: string; confirmLabel: string } | null;
}

export interface MmgClaimPresentation {
  tone: MmgClaimTone;
  title: string;
  body: string;
  actions: MmgClaimAction[];
}

export const I_PAID = 'I paid the store';
export const I_DID_NOT_PAY = 'I didn’t pay';

export function mmgClaimPresentation(v: MmgClaimView): MmgClaimPresentation {
  // A rejected store report leaves one way forward — cancelling — so no
  // statement is offered; the server's `canClaim` is the other boundary.
  const offer = v.canClaim && !v.attemptRejected;
  const actions: MmgClaimAction[] = [];
  if (offer && v.customerClaim !== 'PAID') actions.push({ paid: true, label: I_PAID, confirm: null });
  if (offer && v.customerClaim !== 'NOT_PAID') {
    actions.push({
      paid: false,
      label: I_DID_NOT_PAY,
      confirm: {
        title: 'Tell us you didn’t pay?',
        body: v.storeClaimed || v.providerCaptured
          ? 'The store says your MMG payment arrived. If you didn’t pay, Swift pauses the order until a person checks.'
          : 'We’ll note that you haven’t paid. If the store later reports a payment, Swift pauses the order until a person checks.',
        confirmLabel: I_DID_NOT_PAY,
      },
    });
  }

  if (v.disputed) {
    return {
      tone: 'warning',
      title: 'Payment under review',
      body: 'You and the store disagree about this MMG payment. The order is paused until a person reviews it — Swift never holds this money.',
      actions,
    };
  }
  if (v.attemptRejected) {
    return {
      tone: 'warning',
      title: 'No payment found',
      body: 'Swift support decided the store did not receive an MMG payment for this order, so it won’t be prepared or delivered. You can cancel it.',
      actions,
    };
  }
  if (v.resolution === 'CUSTOMER_PAID') {
    return {
      tone: 'success',
      title: 'Payment review finished',
      body: 'Swift support accepted the store’s report that your MMG payment arrived. The order can continue.',
      actions,
    };
  }
  if (v.providerCaptured) {
    return { tone: 'success', title: 'MMG payment received', body: 'MMG reported this payment to the store.', actions };
  }
  if (v.storeClaimed) {
    return {
      tone: 'neutral',
      title: 'The store reported your payment',
      body: 'The store says your MMG payment arrived. Swift doesn’t hold or check this money — if you didn’t pay, tell us.',
      actions,
    };
  }
  if (v.customerClaim === 'PAID') {
    return { tone: 'neutral', title: 'Waiting for the store', body: 'You told us you paid. The store confirms once the money shows in its MMG wallet.', actions };
  }
  if (v.customerClaim === 'NOT_PAID') {
    return { tone: 'neutral', title: 'Not paid yet', body: 'You told us you haven’t paid. Pay the store with MMG to continue, or cancel the order.', actions };
  }
  return { tone: 'neutral', title: 'Paid the store already?', body: 'After you pay in MMG, tell us here so the store knows to check its wallet.', actions };
}
