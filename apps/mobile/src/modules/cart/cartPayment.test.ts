import { describe, expect, it } from 'vitest';
import type { CartPaymentCapabilities, MmgDirectPaymentAction } from '@swift/types';
import {
  cartPaymentOptions,
  checkoutPaymentFields,
  checkoutPaymentMethod,
  mmgOffered,
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

// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] MMG to the store's NUMBER (build 12 + web). The old link rail is off on
// the server (builds 9-11 see cash only); the number rail is read from `mmgStoreNumber`, preferred over the link,
// and the checkout tells the server which rail it chose.
describe('[PAYMENT-SIMPLIFY] MMG to the store number', () => {
  const numberCaps = (available: boolean) => normalizeCartPaymentCapabilities({
    scope: 'scope-n',
    cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' },
    mmg: { available: false, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', unavailableReason: 'PAY_LINKS_OFF' },
    mmgStoreNumber: { available, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', payTo: 'STORE_NUMBER', shownWhen: 'STORE_ACCEPTS', unavailableReason: available ? null : 'VENDOR_NOT_CONFIGURED' },
  });

  it('offers MMG from the number rail alone, with the after-acceptance wording', () => {
    const caps = numberCaps(true);
    expect(caps.mmg.available).toBe(false);
    const options = cartPaymentOptions(caps, { appointmentOnly: false, pickup: false });
    expect(options.map((o) => o.key)).toEqual(['CASH', 'MMG']);
    expect(options[1]!.sub).toBe('When the business accepts, your order shows its MMG number and the exact amount. Pay within 30 minutes of it accepting, or the order cancels automatically. You pay the business directly in MMG. Swift never holds the money.');
  });

  it('a chosen MMG checks out to the number, and says so', () => {
    const caps = numberCaps(true);
    const selection = selectCartPaymentMethod('MMG', caps);
    expect(selection.method).toBe('MMG');
    expect(checkoutPaymentFields(selection, caps)).toEqual({ paymentMethod: 'MOBILE_MONEY', mmgPayTo: 'STORE_NUMBER' });
    expect(checkoutPaymentFields(selectCartPaymentMethod('CASH', caps), caps)).toEqual({ paymentMethod: 'CASH' });
  });

  it('no number (or an older server without the field): cash only, a stale MMG choice degrades', () => {
    for (const caps of [numberCaps(false), capabilities('scope-n', false)]) {
      expect(mmgOffered(caps)).toBe(false);
      expect(cartPaymentOptions(caps, { appointmentOnly: false, pickup: false }).map((o) => o.key)).toEqual(['CASH']);
      expect(checkoutPaymentFields({ method: 'MMG', scope: 'scope-n' }, caps)).toEqual({ paymentMethod: 'CASH' });
    }
  });

  it('a malformed number capability is not an offer', () => {
    const caps = normalizeCartPaymentCapabilities({
      scope: 'scope-x', mmg: { available: false },
      mmgStoreNumber: { available: true, provider: 'MMG', fundsFlow: 'DIRECT_TO_VENDOR', payTo: 'LINK' },
    });
    expect(mmgOffered(caps)).toBe(false);
  });

  it('the old link rail, when a server still offers it, checks out without the number marker', () => {
    const caps = capabilities('scope-l', true);
    expect(checkoutPaymentFields(selectCartPaymentMethod('MMG', caps), caps)).toEqual({ paymentMethod: 'MOBILE_MONEY' });
  });

  it('the confirmation says the number comes on the order once the business accepts', () => {
    expect(placedOrderConfirmationCopy({ appointment: false, pickup: false, held: false, submittedMethod: 'MOBILE_MONEY', paymentAction: null, mmgPayTo: 'STORE_NUMBER' }))
      .toBe('When the business accepts, your order screen shows its MMG number and the exact amount to send. Pay within 30 minutes of it accepting, or the order cancels automatically. You pay the business directly in MMG; it marks the order paid when the money arrives. Swift never holds the money.');
  });
});
