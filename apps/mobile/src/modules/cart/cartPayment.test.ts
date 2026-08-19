import { describe, expect, it } from 'vitest';
import type { CartPaymentCapabilities, MmgDirectPaymentAction } from '@swift/types';
import {
  cartPaymentOptions,
  checkoutPaymentMethod,
  normalizeCartPaymentCapabilities,
  paymentActionForCheckout,
  placedOrderConfirmationCopy,
  reconcileCartPaymentSelection,
  selectCartPaymentMethod,
} from './cartPayment';

function capabilities(scope: string, mmg: boolean): CartPaymentCapabilities {
  return {
    scope,
    cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' },
    mmg: {
      available: mmg,
      provider: 'MMG',
      fundsFlow: 'DIRECT_TO_VENDOR',
      unavailableReason: mmg ? null : 'VENDOR_NOT_CONFIGURED',
    },
  };
}

const action: MmgDirectPaymentAction = {
  kind: 'OPEN_EXTERNAL_URL',
  method: 'MOBILE_MONEY',
  provider: 'MMG',
  fundsFlow: 'DIRECT_TO_VENDOR',
  orderId: 'order-1',
  recipientName: 'Green Bowl',
  amount: 2500,
  url: 'https://pay.example.com/pay/green-bowl',
};

describe('cart MMG capability and selection', () => {
  it('fails a missing/partial rolling-deploy capability to cash only', () => {
    const normalized = normalizeCartPaymentCapabilities(undefined);
    expect(normalized.cash.available).toBe(true);
    expect(normalized.mmg.available).toBe(false);
    expect(cartPaymentOptions(normalized, { appointmentOnly: false, pickup: false }).map((o) => o.key)).toEqual(['CASH']);
  });

  it('shows MMG only from the cart-level server capability', () => {
    expect(cartPaymentOptions(capabilities('cart-a', false), { appointmentOnly: false, pickup: false }).map((o) => o.key)).toEqual(['CASH']);
    expect(cartPaymentOptions(capabilities('cart-a', true), { appointmentOnly: false, pickup: false }).map((o) => o.key)).toEqual(['CASH', 'MMG']);
  });

  it('degrades stale MMG to cash and never revives it in a later capable scope', () => {
    const first = capabilities('vendor-a', true);
    const selected = selectCartPaymentMethod('MMG', first);
    expect(checkoutPaymentMethod(selected, first)).toBe('MOBILE_MONEY');

    const unavailable = capabilities('vendor-a-invalid', false);
    const degraded = reconcileCartPaymentSelection(selected, unavailable);
    expect(degraded).toEqual({ method: 'CASH', scope: 'vendor-a-invalid' });
    expect(checkoutPaymentMethod(degraded, unavailable)).toBe('CASH');

    const laterVendor = capabilities('vendor-b', true);
    const reconciledLater = reconcileCartPaymentSelection(degraded, laterVendor);
    expect(reconciledLater).toEqual({ method: 'CASH', scope: 'vendor-b' });
    expect(checkoutPaymentMethod(reconciledLater, laterVendor)).toBe('CASH');
  });
});

describe('post-checkout MMG action and confirmation copy', () => {
  it('accepts the explicit no-custody action only for the submitted MMG method', () => {
    const result = { paymentAction: action };
    expect(paymentActionForCheckout(result, 'MOBILE_MONEY')).toEqual(action);
    expect(paymentActionForCheckout(result, 'CASH')).toBeNull();
    expect(paymentActionForCheckout({ paymentAction: { ...action, fundsFlow: 'SWIFT_WALLET' } as never }, 'MOBILE_MONEY')).toBeNull();
    expect(paymentActionForCheckout({ paymentAction: { ...action, amount: Number.NaN } }, 'MOBILE_MONEY')).toBeNull();
    expect(paymentActionForCheckout({ paymentAction: { ...action, amount: -1 } }, 'MOBILE_MONEY')).toBeNull();
    expect(paymentActionForCheckout({ paymentAction: { ...action, recipientName: '   ' } }, 'MOBILE_MONEY')).toBeNull();
    expect(paymentActionForCheckout({ paymentAction: { ...action, orderId: '' } }, 'MOBILE_MONEY')).toBeNull();
  });

  it('states the MMG and cash funds flows honestly', () => {
    const mmgCopy = placedOrderConfirmationCopy({
      appointment: false,
      pickup: false,
      held: false,
      submittedMethod: 'MOBILE_MONEY',
      paymentAction: action,
    });
    expect(mmgCopy).toContain('directly to Green Bowl');
    expect(mmgCopy).toContain('Swift does not hold the money');
    expect(mmgCopy).not.toContain('cash');

    const cashCopy = placedOrderConfirmationCopy({
      appointment: false,
      pickup: false,
      held: false,
      submittedMethod: 'CASH',
      paymentAction: null,
    });
    expect(cashCopy).toContain('pay cash at handover');
    expect(cashCopy).toContain('Swift never holds the order money');
    expect(cashCopy).not.toContain('MMG');
  });
});
