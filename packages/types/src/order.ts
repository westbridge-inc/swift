export enum OrderType {
  FOOD_DELIVERY = 'FOOD_DELIVERY',
  GROCERY_DELIVERY = 'GROCERY_DELIVERY',
  COURIER = 'COURIER',
  TAXI = 'TAXI',
}

export enum OrderStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  PREPARING = 'PREPARING',
  READY_FOR_PICKUP = 'READY_FOR_PICKUP',
  RIDER_ASSIGNED = 'RIDER_ASSIGNED',
  RIDER_EN_ROUTE_PICKUP = 'RIDER_EN_ROUTE_PICKUP',
  RIDER_ARRIVED_PICKUP = 'RIDER_ARRIVED_PICKUP',
  PICKED_UP = 'PICKED_UP',
  EN_ROUTE_DELIVERY = 'EN_ROUTE_DELIVERY',
  ARRIVED = 'ARRIVED',
  DRIVER_ASSIGNED = 'DRIVER_ASSIGNED',
  DRIVER_EN_ROUTE = 'DRIVER_EN_ROUTE',
  DRIVER_ARRIVED = 'DRIVER_ARRIVED',
  RIDE_IN_PROGRESS = 'RIDE_IN_PROGRESS',
  DELIVERED = 'DELIVERED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

export enum PackageSize {
  SMALL = 'SMALL',
  MEDIUM = 'MEDIUM',
  LARGE = 'LARGE',
  EXTRA_LARGE = 'EXTRA_LARGE',
}

export enum PaymentMethod {
  CASH = 'CASH',
  MOBILE_MONEY = 'MOBILE_MONEY',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CARD = 'CARD',
  WALLET = 'WALLET',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  CAPTURED = 'CAPTURED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
}

/** The only order-payment action Swift may return: open the vendor's validated
 * direct-pay destination. It is not a Swift payment intent and creates no
 * wallet balance, custody, or settlement obligation for Swift. */
export interface MmgDirectPaymentAction {
  kind: 'OPEN_EXTERNAL_URL';
  method: 'MOBILE_MONEY';
  provider: 'MMG';
  fundsFlow: 'DIRECT_TO_VENDOR';
  orderId: string;
  recipientName: string;
  amount: number;
  url: string;
}

export interface OrderCheckoutResult<TOrder = unknown> {
  order: TOrder;
  orders: TOrder[];
  grandTotal: number;
  message: string;
  paymentAction: MmgDirectPaymentAction | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  orderType: OrderType;
  customerId: string;
  vendorId?: string | null;
  riderId?: string | null;
  driverId?: string | null;
  ridePin?: string | null;
  ridePinVerified: boolean;
  ridePinAttempts: number;
  status: OrderStatus;
  pickupAddress?: string | null;
  pickupLat?: number | null;
  pickupLng?: number | null;
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  deliveryInstructions?: string | null;
  courierPackageDescription?: string | null;
  courierPackageSize?: PackageSize | null;
  courierPackageWeight?: number | null;
  courierPackagePhotoUrl?: string | null;
  subtotalBase: number;
  subtotalMarkup: number;
  subtotalCustomer: number;
  deliveryFee: number;
  serviceFee: number;
  taxAmount: number;
  tipAmount: number;
  discount: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  estimatedPrepTime?: number | null;
  estimatedDeliveryTime?: number | null;
  scheduledFor?: string | null;
  placedAt: string;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  pickedUpAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  cancellationReason?: string | null;
  items?: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  itemId: string;
  name: string;
  quantity: number;
  basePrice: number;
  markedUpPrice: number;
  markupAmount: number;
  totalBase: number;
  totalMarkup: number;
  totalCustomer: number;
  selectedOptions?: OrderItemOption[];
  specialInstructions?: string | null;
}

export interface OrderItemOption {
  id: string;
  orderItemId: string;
  optionGroupName: string;
  optionName: string;
  basePrice: number;
  markedUpPrice: number;
  markupAmount: number;
}

export interface OrderStatusLog {
  id: string;
  orderId: string;
  status: OrderStatus;
  note?: string | null;
  changedBy?: string | null;
  createdAt: string;
}
