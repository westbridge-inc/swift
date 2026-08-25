/**
 * WIRE fixtures — deliberately built the way `GET /api/v1/vendor/orders` and
 * `GET /api/v1/vendor/orders/:id` actually answer, NOT the way the web client
 * once wished they did.
 *
 * The three properties that matter, all verified against
 * `apps/api/prisma/schema.prisma` + `apps/api/src/modules/vendor/vendor.routes.ts`:
 *
 *  1. Both routes return RAW Prisma rows, so every `@db.Decimal` column is a
 *     **STRING** (`"4500.00"`), never a JS number. No global Decimal `toJSON`
 *     patch and no Prisma result extension touches serialisation.
 *  2. There is NO `total` on Order and NO `totalPrice` on OrderItem. The real
 *     columns are `Order.totalAmount` and `OrderItem.totalCustomer`.
 *  3. HND-003: both routes `omit` `pickupCode` / `pickupCodeAttempts` /
 *     `ridePin`. The vendor VERIFIES the handover code; it never READS it. So
 *     no fixture here carries one — because no response ever does.
 *
 * No real person, phone, address or business appears here: the repo is public.
 */

/** One OrderItem row exactly as `include: { items: true }` returns it. */
export function wireOrderLine(over: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    orderId: 'order-live',
    itemId: 'item-1',
    name: 'Pepperpot',
    quantity: 2,
    basePrice: '1500.00',
    markedUpPrice: '1500.00',
    markupAmount: '0.00',
    totalBase: '3000.00',
    totalMarkup: '0.00',
    totalCustomer: '3000.00',
    specialInstructions: 'No pepper please',
    picked: false,
    subStatus: 'NONE',
    substituteItemId: null,
    substituteName: null,
    substitutePrice: null,
    ...over,
  };
}

/** One Order row as the BOARD (`GET /orders`) returns it. */
export function wireVendorOrder(over: Record<string, unknown> = {}) {
  return {
    id: 'order-live',
    tenantId: 'swift-default',
    orderNumber: 'SW-1001',
    orderType: 'FOOD',
    customerId: 'customer-1',
    vendorId: 'vendor-1',
    riderId: null,
    driverId: null,
    status: 'PENDING',
    pickupAddress: null,
    deliveryAddress: '1 Test Road',
    deliveryLat: 6.8,
    deliveryLng: -58.15,
    deliveryInstructions: 'Ring the bell twice',
    subtotalBase: '4000.00',
    subtotalMarkup: '0.00',
    subtotalCustomer: '4000.00',
    deliveryFee: '500.00',
    serviceFee: '0.00',
    taxAmount: '0.00',
    tipAmount: '0.00',
    discount: '0.00',
    totalAmount: '4500.00',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    fulfillment: 'DELIVERY',
    fulfillmentMode: null,
    estimatedPrepTime: null,
    placedAt: new Date().toISOString(),
    acceptedAt: null,
    preparingAt: null,
    readyAt: null,
    items: [
      wireOrderLine(),
      wireOrderLine({ id: 'line-2', itemId: 'item-2', name: 'Plantain', quantity: 1, totalCustomer: '1000.00', specialInstructions: null }),
    ],
    customer: { id: 'customer-1', firstName: 'Test', lastName: 'Customer', avatar: null },
    rider: null,
    vendor: { id: 'vendor-1', name: 'Test Kitchen', selfDeliveryEnabled: false },
    ...over,
  };
}

/** The same order as the DETAIL route returns it (different vendor select). */
export function wireVendorOrderDetail(over: Record<string, unknown> = {}) {
  return {
    ...wireVendorOrder(),
    // The detail route selects `phone` instead of `avatar`, and vendorType
    // instead of id/name — a different shape from the same table.
    customer: { id: 'customer-1', firstName: 'Test', lastName: 'Customer', phone: '+5920000000' },
    vendor: { vendorType: 'RESTAURANT', selfDeliveryEnabled: false },
    statusHistory: [{ status: 'PENDING', createdAt: new Date().toISOString(), note: null }],
    ...over,
  };
}
