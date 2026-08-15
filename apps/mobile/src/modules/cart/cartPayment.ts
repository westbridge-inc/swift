import type {
  CartPaymentCapabilities,
  MmgDirectPaymentAction,
  OrderCheckoutResult,
} from '@swift/types';

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
  };
}

export function reconcileCartPaymentSelection(
  selection: CartPaymentSelection,
  capabilities: CartPaymentCapabilities,
): CartPaymentSelection {
  if (selection.scope !== capabilities.scope) {
    return { method: 'CASH', scope: capabilities.scope };
  }
  if (selection.method === 'MMG' && !capabilities.mmg.available) {
    return { method: 'CASH', scope: capabilities.scope };
  }
  return selection;
}

export function selectCartPaymentMethod(
  method: CartPaymentChoice,
  capabilities: CartPaymentCapabilities,
): CartPaymentSelection {
  return {
    method: method === 'MMG' && !capabilities.mmg.available ? 'CASH' : method,
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
  if (!capabilities.mmg.available) return [cash];
  return [
    cash,
    {
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
  pickup: boolean;
  held: boolean;
  submittedMethod: 'CASH' | 'MOBILE_MONEY';
  paymentAction: MmgDirectPaymentAction | null;
}): string {
  if (input.submittedMethod === 'MOBILE_MONEY') {
    if (input.paymentAction) {
      return `Complete payment directly to ${input.paymentAction.recipientName} in MMG. Swift does not hold the money; the business confirms it after receipt.`;
    }
    return 'Your MMG order was placed, but its payment link is unavailable. Do not send money to another link; open the order for the latest payment action.';
  }
  if (input.appointment) {
    return 'Your time is confirmed when the business accepts — pay cash directly to them when the service is done.';
  }
  if (input.pickup) {
    return 'We’ll tell you when it’s ready — show the pickup code and pay cash directly at the counter.';
  }
  if (input.held) {
    return 'You have a few minutes to change your mind — cancelling is free until the store gets it. Pay cash at handover.';
  }
  return 'The store has been notified — pay cash at handover. Swift never holds the order money.';
}
