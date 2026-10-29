import type {
  CartPaymentCapabilities,
  MmgDirectPaymentAction,
  OrderCheckoutResult,
} from '@swift/types';

/** [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] How a checkout says it pays the store's MMG NUMBER. */
export const MMG_PAY_TO_STORE_NUMBER = 'STORE_NUMBER' as const;

export type CartPaymentChoice = 'CASH' | 'MMG';

export interface CartPaymentSelection {
  method: CartPaymentChoice;
  /** Must equal the current server capability scope. */
  scope: string;
}

export interface CartPaymentOptionModel {
  key: CartPaymentChoice;
  icon: 'dollar-sign' | 'smartphone';
  title: string;
  sub: string;
}

const LEGACY_CASH_ONLY_SCOPE = 'cash-only:legacy';

/** Rolling-deploy and malformed-payload safe: absent capability means cash,
 * never the historically over-broad "MMG by default" behavior. */
export function normalizeCartPaymentCapabilities(
  value: unknown,
): CartPaymentCapabilities {
  const candidate = value as Partial<CartPaymentCapabilities> | null | undefined;
  const scope = typeof candidate?.scope === 'string' && candidate.scope.length > 0
    ? candidate.scope
    : LEGACY_CASH_ONLY_SCOPE;
  const mmgAvailable = candidate?.mmg?.available === true
    && candidate.mmg.provider === 'MMG'
    && candidate.mmg.fundsFlow === 'DIRECT_TO_VENDOR';
  // [PAYMENT-SIMPLIFY] The store-number rail, accepted only in its exact shape; absent = not offered.
  const number = candidate?.mmgStoreNumber;
  const numberAvailable = number?.available === true
    && number.provider === 'MMG'
    && number.fundsFlow === 'DIRECT_TO_VENDOR'
    && number.payTo === MMG_PAY_TO_STORE_NUMBER;
  return {
    scope,
    cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' },
    mmg: {
      available: mmgAvailable,
      provider: 'MMG',
      fundsFlow: 'DIRECT_TO_VENDOR',
      unavailableReason: mmgAvailable
        ? null
        : candidate?.mmg?.unavailableReason ?? 'VENDOR_NOT_CONFIGURED',
    },
    mmgStoreNumber: {
      available: numberAvailable,
      provider: 'MMG',
      fundsFlow: 'DIRECT_TO_VENDOR',
      payTo: MMG_PAY_TO_STORE_NUMBER,
      shownWhen: 'STORE_ACCEPTS',
      unavailableReason: numberAvailable ? null : number?.unavailableReason ?? 'VENDOR_NOT_CONFIGURED',
    },
  };
}

/** Is MMG on offer for this cart at all — to the store's number (preferred), or the old link? */
export function mmgOffered(capabilities: CartPaymentCapabilities): boolean {
  return capabilities.mmgStoreNumber?.available === true || capabilities.mmg.available;
}

/** The checkout body's payment fields for this selection: MMG goes to the store's number when the server
 * offers it (the old link only when it does not), and the server is told which. */
export function checkoutPaymentFields(
  selection: CartPaymentSelection,
  capabilities: CartPaymentCapabilities,
): { paymentMethod: 'CASH' } | { paymentMethod: 'MOBILE_MONEY'; mmgPayTo?: typeof MMG_PAY_TO_STORE_NUMBER } {
  if (checkoutPaymentMethod(selection, capabilities) !== 'MOBILE_MONEY') return { paymentMethod: 'CASH' };
  return capabilities.mmgStoreNumber?.available === true
    ? { paymentMethod: 'MOBILE_MONEY', mmgPayTo: MMG_PAY_TO_STORE_NUMBER }
    : { paymentMethod: 'MOBILE_MONEY' };
}

export function reconcileCartPaymentSelection(
  selection: CartPaymentSelection,
  capabilities: CartPaymentCapabilities,
): CartPaymentSelection {
  if (selection.scope !== capabilities.scope) {
    return { method: 'CASH', scope: capabilities.scope };
  }
  if (selection.method === 'MMG' && !mmgOffered(capabilities)) {
    return { method: 'CASH', scope: capabilities.scope };
  }
  return selection;
}

export function selectCartPaymentMethod(
  method: CartPaymentChoice,
  capabilities: CartPaymentCapabilities,
): CartPaymentSelection {
  return {
    method: method === 'MMG' && !mmgOffered(capabilities) ? 'CASH' : method,
    scope: capabilities.scope,
  };
}

export function checkoutPaymentMethod(
  selection: CartPaymentSelection,
  capabilities: CartPaymentCapabilities,
): 'CASH' | 'MOBILE_MONEY' {
  return reconcileCartPaymentSelection(selection, capabilities).method === 'MMG'
    ? 'MOBILE_MONEY'
    : 'CASH';
}

export function cartPaymentOptions(
  capabilities: CartPaymentCapabilities,
  context: { appointmentOnly: boolean; pickup: boolean },
): CartPaymentOptionModel[] {
  const cash: CartPaymentOptionModel = {
    key: 'CASH',
    icon: 'dollar-sign',
    title: context.appointmentOnly
      ? 'Pay at your appointment'
      : context.pickup
        ? 'Pay at the counter'
        : 'Cash on delivery',
    sub: context.appointmentOnly
      ? 'Pay cash directly to the business when the service is done.'
      : context.pickup
        ? 'Pay cash directly to the business when you collect your order.'
        : 'Pay cash at handover. Swift never holds the order money.',
  };
  if (!mmgOffered(capabilities)) return [cash];
  return [
    cash,
    capabilities.mmgStoreNumber?.available === true
      ? {
          key: 'MMG',
          icon: 'smartphone',
          title: 'Pay with MMG',
          // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The number is shown only after the store accepts.
          sub: 'When the business accepts, your order shows its MMG number and the exact amount. Pay within 30 minutes of it accepting, or the order cancels automatically. You pay the business directly in MMG. Swift never holds the money.',
        }
      : {
          key: 'MMG',
          icon: 'smartphone',
          title: 'Pay with MMG',
          sub: 'Pay the business directly in MMG after placing the order. Swift never holds the money.',
        },
  ];
}

/** Accept an action only when it belongs to this MMG checkout and preserves
 * the no-custody contract. URL safety is checked again by openMmgPaymentAction. */
export function paymentActionForCheckout(
  result: Partial<OrderCheckoutResult>,
  submittedMethod: 'CASH' | 'MOBILE_MONEY',
): MmgDirectPaymentAction | null {
  const action = result.paymentAction as Partial<MmgDirectPaymentAction> | null | undefined;
  if (
    submittedMethod !== 'MOBILE_MONEY'
    || action?.kind !== 'OPEN_EXTERNAL_URL'
    || action.method !== 'MOBILE_MONEY'
    || action.provider !== 'MMG'
    || action.fundsFlow !== 'DIRECT_TO_VENDOR'
    || typeof action.orderId !== 'string'
    || action.orderId.trim().length === 0
    || typeof action.recipientName !== 'string'
    || action.recipientName.trim().length === 0
    || typeof action.amount !== 'number'
    || !Number.isFinite(action.amount)
    || action.amount < 0
    || typeof action.url !== 'string'
    || action.url.trim().length === 0
  ) {
    return null;
  }
  return action as MmgDirectPaymentAction;
}

export function placedOrderConfirmationCopy(input: {
  appointment: boolean;
  /** [BOOK-S6a] The checkout answer came back ACCEPTED: the business's listing confirmed it at once. */
  appointmentConfirmed?: boolean;
  pickup: boolean;
  held: boolean;
  submittedMethod: 'CASH' | 'MOBILE_MONEY';
  paymentAction: MmgDirectPaymentAction | null;
  /** [PAYMENT-SIMPLIFY] The order pays the store's MMG number (shown on the order once it accepts). */
  mmgPayTo?: typeof MMG_PAY_TO_STORE_NUMBER;
}): string {
  if (input.submittedMethod === 'MOBILE_MONEY' && input.mmgPayTo === MMG_PAY_TO_STORE_NUMBER) {
    return 'When the business accepts, your order screen shows its MMG number and the exact amount to send. Pay within 30 minutes of it accepting, or the order cancels automatically. You pay the business directly in MMG; it marks the order paid when the money arrives. Swift never holds the money.';
  }
  if (input.submittedMethod === 'MOBILE_MONEY') {
    if (input.paymentAction) {
      return `Complete payment directly to ${input.paymentAction.recipientName} in MMG. Swift does not hold the money; the business confirms it after receipt.`;
    }
    return 'Your MMG order was placed, but its payment link is unavailable. Do not send money to another link; open the order for the latest payment action.';
  }
  if (input.appointment && input.appointmentConfirmed === true) {
    return 'Your time is confirmed — pay cash directly to the business when the service is done.';
  }
  if (input.appointment) {
    return 'Your time is confirmed when the business accepts — pay cash directly to them when the service is done.';
  }
  if (input.pickup) {
    return 'We’ll tell you when it’s ready — show the pickup code and pay cash directly at the counter.';
  }
  if (input.held) {
    // [REPORT-013 F-013-03 S2] This popup can outlive the hold (one-time
    // device-clock snapshot, no timer) — state the RULE, never "is free"
    // as a standing promise the order screen may already contradict.
    // [Terms 2026-10-15 §7 · review S3-1 on #1732] free until the store ACCEPTS, not only while it has not been told
    return 'Changed your mind? Until the store accepts it, you can cancel free from the order screen. Pay cash at handover.';
  }
  return 'The store has been notified — pay cash at handover. Swift never holds the order money.';
}
