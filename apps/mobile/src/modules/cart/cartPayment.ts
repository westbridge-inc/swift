import type { CartPaymentCapabilities } from '@swift/types';

// [perf · BOOK-WEB #2206] What a cart shows BEFORE an order is placed (the payment choices and the checkout's payment
// fields). What is said and opened AFTER it is placed (the confirmation copy, the MMG pay action) lives in
// ./cartPlaced, so the website's checkout loads it only with its success panel.

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
          // [BOOK-FU3 · REVIEW-F S4 #2202] A booking is a booking, never an "order".
          sub: context.appointmentOnly
            ? 'When the business accepts, your booking shows its MMG number and the exact amount. Pay within 30 minutes of it accepting, or the booking cancels automatically. You pay the business directly in MMG. Swift never holds the money.'
            : 'When the business accepts, your order shows its MMG number and the exact amount. Pay within 30 minutes of it accepting, or the order cancels automatically. You pay the business directly in MMG. Swift never holds the money.',
        }
      : {
          key: 'MMG',
          icon: 'smartphone',
          title: 'Pay with MMG',
          sub: context.appointmentOnly
            ? 'Pay the business directly in MMG after booking. Swift never holds the money.'
            : 'Pay the business directly in MMG after placing the order. Swift never holds the money.',
        },
  ];
}
