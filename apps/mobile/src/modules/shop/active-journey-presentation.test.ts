import { describe, expect, it } from 'vitest';
import { activeJourneyPresentation, activeJourneyRecipient } from './active-journey-presentation';

describe('Home active-journey identity', () => {
  it('does not disguise a courier request as a generic order', () => {
    expect(activeJourneyPresentation({
      orderType: 'COURIER',
      fulfillment: 'DELIVERY',
      status: 'READY_FOR_PICKUP',
      orderNumber: 'SW-260920-00244R',
    })).toEqual({
      title: 'Courier request · Ready for rider pickup',
      subtitle: 'Parcel delivery · #SW-260920-00244R',
    });
  });

  it.each([
    [{ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'PREPARING' }, 'Food order · Being prepared'],
    [{ orderType: 'GROCERY_DELIVERY', fulfillment: 'DELIVERY', status: 'ACCEPTED' }, 'Grocery order · Order accepted'],
    [{ orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP' }, 'Pickup order · Ready for pickup'],
    [{ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }, 'Appointment · Order accepted'],
    [{ orderType: 'TAXI', fulfillment: 'DELIVERY', status: 'DRIVER_EN_ROUTE' }, 'Taxi ride · Driver on the way'],
  ])('names the journey before its status', (order, title) => {
    expect(activeJourneyPresentation(order).title).toBe(title);
  });

  it('keeps an unknown courier state vertical-specific', () => {
    expect(activeJourneyPresentation({ orderType: 'COURIER', status: 'A_NEW_STATE' }).title)
      .toBe('Courier request in progress');
  });

  it('uses the vendor and order number when a store exists', () => {
    expect(activeJourneyPresentation({
      orderType: 'GROCERY_DELIVERY',
      fulfillment: 'DELIVERY',
      status: 'PENDING',
      orderNumber: 'SW-42',
      vendor: { name: 'Fresh Mart' },
    }).subtitle).toBe('Fresh Mart · #SW-42');
  });

  it('never labels a service business as food when a legacy order enum is FOOD_DELIVERY', () => {
    expect(activeJourneyPresentation({
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY',
      status: 'PENDING',
      orderNumber: 'SW-SERVICE-1',
      vendor: { name: 'Sharp Cuts Barbershop', vendorType: 'SERVICE' },
    }).title).toBe('Service order · Waiting for provider');
    expect(activeJourneyRecipient({ vendor: { vendorType: 'SERVICE' } })).toBe('provider');
  });
});
