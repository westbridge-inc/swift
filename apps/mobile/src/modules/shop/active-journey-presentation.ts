import { orderStatusLabel, orderSubtitle } from '../../lib/orderStatus';

type ActiveJourney = {
  orderType?: string | null;
  fulfillment?: string | null;
  status?: string | null;
  orderNumber?: string | null;
  vendor?: { name?: string | null } | null;
};

export function activeJourneyName(order: ActiveJourney): string {
  if (order.fulfillment === 'APPOINTMENT') return 'Appointment';
  if (order.fulfillment === 'PICKUP') return 'Pickup order';

  switch (order.orderType) {
    case 'COURIER': return 'Courier request';
    case 'TAXI': return 'Taxi ride';
    case 'GROCERY_DELIVERY': return 'Grocery order';
    case 'FOOD_DELIVERY': return 'Food order';
    default: return 'Order';
  }
}

function journeyStatus(order: ActiveJourney): string {
  // A courier order becomes READY_FOR_PICKUP when the parcel is ready for a
  // rider, not when a customer should collect it from a shop. The shared
  // status table intentionally does not borrow store language for courier
  // states, so Home supplies this courier-specific phrase here.
  if (order.orderType === 'COURIER' && order.status === 'READY_FOR_PICKUP') {
    return 'Ready for rider pickup';
  }
  return orderStatusLabel(order.status, order.orderType);
}

export function activeJourneyPresentation(order: ActiveJourney): {
  title: string;
  subtitle: string;
} {
  const name = activeJourneyName(order);
  const status = journeyStatus(order);
  const title = status === 'In progress' ? `${name} in progress` : `${name} · ${status}`;

  const storeSubtitle = orderSubtitle(order.vendor?.name, order.orderNumber);
  if (order.vendor?.name) return { title, subtitle: storeSubtitle };

  const context = order.orderType === 'COURIER'
    ? 'Parcel delivery'
    : order.orderType === 'TAXI'
      ? 'Ride'
      : order.fulfillment === 'APPOINTMENT'
        ? 'Appointment'
        : order.fulfillment === 'PICKUP'
          ? 'Store pickup'
          : null;
  const subtitle = [context, order.orderNumber ? `#${order.orderNumber}` : null]
    .filter(Boolean)
    .join(' · ');

  return { title, subtitle };
}
