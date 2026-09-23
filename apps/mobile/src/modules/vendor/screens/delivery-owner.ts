const DELIVERY_OWNER_CHOICE_STATES = new Set([
  'ACCEPTED',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'READY_FOR_PICKUP',
]);

const TERMINAL_STATES = new Set([
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'FAILED',
]);

export interface DeliveryOwnerInput {
  fulfillment?: string | null;
  fulfillmentMode?: string | null;
  status?: string | null;
  riderId?: string | null;
  riderPresent?: boolean;
  selfDeliveryEnabled?: boolean;
}

/** The store may close only its own riderless delivery after the kitchen has
 * marked it ready. The server repeats every predicate under the Order lock. */
export function canVendorConfirmDelivered(input: DeliveryOwnerInput): boolean {
  const status = (input.status ?? '').toUpperCase();
  return input.fulfillment === 'DELIVERY'
    && input.fulfillmentMode === 'VENDOR_DELIVERY'
    && (status === 'READY' || status === 'READY_FOR_PICKUP')
    && !input.riderId
    && !input.riderPresent;
}

/**
 * Project server authority into vendor-facing copy and actions. This never
 * infers that a search is running: only recorded ownership and assignment are
 * presented as facts.
 */
export function deliveryOwnerView(input: DeliveryOwnerInput) {
  const status = (input.status ?? '').toUpperCase();
  const active = input.fulfillment === 'DELIVERY' && !TERMINAL_STATES.has(status);
  const riderAssigned = Boolean(input.riderId || input.riderPresent);
  const selfDelivery = input.fulfillmentMode === 'VENDOR_DELIVERY';
  const mayChange = active && DELIVERY_OWNER_CHOICE_STATES.has(status) && !riderAssigned;
  const canChooseVendor = mayChange && input.selfDeliveryEnabled === true && !selfDelivery;
  // A store whose global self-delivery setting was disabled later must still
  // be able to return an already-self-owned order to Swift.
  const canChoosePlatform = mayChange && selfDelivery;

  const title = selfDelivery
    ? 'Your store delivers this order'
    : riderAssigned
      ? 'A Swift rider delivers this order'
      : input.fulfillmentMode === 'PLATFORM_RIDER'
        ? 'Platform rider delivery selected'
        : 'Delivery owner not chosen yet';

  const description = selfDelivery
    ? 'No Swift rider will be sent for this order.'
    : riderAssigned
      ? 'The assigned rider is responsible for delivery.'
      : input.fulfillmentMode === 'PLATFORM_RIDER'
        ? 'No rider is assigned yet.'
        : 'No delivery owner has been recorded yet.';

  return {
    active,
    riderAssigned,
    selfDelivery,
    canChooseVendor,
    canChoosePlatform,
    title,
    description,
  };
}
