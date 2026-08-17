export interface Cart {
  id: string;
  customerId: string;
  vendorId: string;
  items: CartItem[];
  deliveryAddressId?: string | null;
  scheduledFor?: string | null;
  promoCodeId?: string | null;
  tipAmount: number;
  specialInstructions?: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  /** Server-derived across every unique item vendor. No MMG URL is present in
   * the cart; the validated link is released only after a successful order. */
  paymentCapabilities?: CartPaymentCapabilities;
}

export type MmgCartUnavailableReason =
  | 'MULTI_VENDOR_UNSUPPORTED'
  | 'VENDOR_NOT_CONFIGURED'
  | 'VENDOR_LINK_INVALID';

export interface CartPaymentCapabilities {
  /** Changes when the vendor set or validated payment destination changes. */
  scope: string;
  cash: {
    available: true;
    fundsFlow: 'DIRECT_AT_HANDOVER';
  };
  mmg: {
    available: boolean;
    provider: 'MMG';
    fundsFlow: 'DIRECT_TO_VENDOR';
    unavailableReason: MmgCartUnavailableReason | null;
  };
}

export interface CartItem {
  id: string;
  cartId: string;
  itemId: string;
  quantity: number;
  selectedOptions: CartItemOption[];
  specialInstructions?: string | null;
}

export interface CartItemOption {
  optionGroupId: string;
  optionId: string;
  name: string;
  basePrice: number;
  customerPrice: number;
}

export interface CartValidation {
  isValid: boolean;
  issues: CartIssue[];
}

export interface CartIssue {
  type: 'ITEM_REMOVED' | 'ITEM_UNAVAILABLE' | 'PRICE_CHANGED' | 'INSUFFICIENT_STOCK' | 'VENDOR_CLOSED' | 'BELOW_MINIMUM';
  itemId?: string;
  message: string;
  oldPrice?: number;
  newPrice?: number;
  available?: number;
}
