import { describe, expect, it } from 'vitest';
import { canVendorConfirmDelivered, deliveryOwnerView } from './delivery-owner';

describe('vendor delivery owner contract', () => {
  it('offers self-delivery only when enabled and the server has no rider', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'PLATFORM_RIDER',
      status: 'READY_FOR_PICKUP',
      selfDeliveryEnabled: true,
    })).toMatchObject({
      title: 'Platform rider delivery selected',
      riderAssigned: false,
      canChooseVendor: true,
      canChoosePlatform: false,
    });
  });

  it('keeps the platform-rider escape when global self-delivery was disabled later', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'VENDOR_DELIVERY',
      status: 'PREPARING',
      selfDeliveryEnabled: false,
    })).toMatchObject({
      title: 'Your store delivers this order',
      canChooseVendor: false,
      canChoosePlatform: true,
    });
  });

  it('uses assignment identity rather than a rider display name', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: 'PLATFORM_RIDER',
      status: 'PREPARING',
      riderId: 'rider-without-profile-name',
      selfDeliveryEnabled: true,
    })).toMatchObject({
      title: 'A Swift rider delivers this order',
      riderAssigned: true,
      canChooseVendor: false,
      canChoosePlatform: false,
    });
  });

  it('does not claim a rider search when authority is unresolved', () => {
    expect(deliveryOwnerView({
      fulfillment: 'DELIVERY',
      fulfillmentMode: null,
      status: 'PENDING',
      selfDeliveryEnabled: true,
    })).toMatchObject({
      title: 'Delivery owner not chosen yet',
      description: 'No delivery owner has been recorded yet.',
      canChooseVendor: false,
      canChoosePlatform: false,
    });
  });

  it('does not put pickup or appointments onto the delivery-owner path', () => {
    expect(deliveryOwnerView({ fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' }).active).toBe(false);
    expect(deliveryOwnerView({ fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }).active).toBe(false);
  });

  it('gives only a riderless, store-owned ready delivery its terminal action', () => {
    const base = { fulfillment: 'DELIVERY', status: 'READY_FOR_PICKUP' };
    expect(canVendorConfirmDelivered({ ...base, fulfillmentMode: 'VENDOR_DELIVERY', riderId: null })).toBe(true);
    expect(canVendorConfirmDelivered({ ...base, fulfillmentMode: 'PLATFORM_RIDER', riderId: null })).toBe(false);
    expect(canVendorConfirmDelivered({ ...base, fulfillmentMode: 'VENDOR_DELIVERY', riderId: 'assigned-rider' })).toBe(false);
  });
});
