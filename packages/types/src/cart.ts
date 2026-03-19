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
