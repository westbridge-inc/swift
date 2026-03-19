export enum EarningType {
  DELIVERY_FEE = 'DELIVERY_FEE',
  COURIER_FEE = 'COURIER_FEE',
  TAXI_FARE = 'TAXI_FARE',
  TIP = 'TIP',
}

export enum EarningStatus {
  PENDING = 'PENDING',
  AVAILABLE = 'AVAILABLE',
  PAID_OUT = 'PAID_OUT',
}

export enum SettlementStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PAID = 'PAID',
  FAILED = 'FAILED',
}

export enum TransactionType {
  ORDER_PAYMENT = 'ORDER_PAYMENT',
  ORDER_REFUND = 'ORDER_REFUND',
  WALLET_TOPUP = 'WALLET_TOPUP',
  WALLET_WITHDRAWAL = 'WALLET_WITHDRAWAL',
  SUBSCRIPTION_PAYMENT = 'SUBSCRIPTION_PAYMENT',
  EARNING_PAYOUT = 'EARNING_PAYOUT',
  TIP_RECEIVED = 'TIP_RECEIVED',
  PROMO_CREDIT = 'PROMO_CREDIT',
  ADJUSTMENT = 'ADJUSTMENT',
}

export enum DiscountType {
  PERCENTAGE = 'PERCENTAGE',
  FIXED_AMOUNT = 'FIXED_AMOUNT',
  FREE_DELIVERY = 'FREE_DELIVERY',
}

export interface Earning {
  id: string;
  riderId?: string | null;
  driverId?: string | null;
  orderId: string;
  type: EarningType;
  amount: number;
  status: EarningStatus;
  createdAt: string;
}

export interface Settlement {
  id: string;
  vendorId: string;
  periodStart: string;
  periodEnd: string;
  totalOrders: number;
  totalBase: number;
  totalMarkup: number;
  status: SettlementStatus;
  paidAt?: string | null;
  reference?: string | null;
  createdAt: string;
}

export interface Transaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  direction: 'CREDIT' | 'DEBIT';
  description: string;
  reference?: string | null;
  externalRef?: string | null;
  balanceAfter: number;
  createdAt: string;
}

export interface PromoCode {
  id: string;
  code: string;
  description: string;
  discountType: DiscountType;
  discountValue: number;
  minOrderAmount?: number | null;
  maxDiscount?: number | null;
  applicableTo: string[];
  validFrom: string;
  validUntil: string;
  maxUses?: number | null;
  maxUsesPerUser: number;
  currentUses: number;
  isActive: boolean;
}

export enum PayoutMethod {
  WALLET = 'WALLET',
  MOBILE_MONEY = 'MOBILE_MONEY',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CASH_PICKUP = 'CASH_PICKUP',
}

export enum PayoutStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export interface PayoutRequest {
  id: string;
  userId: string;
  amount: number;
  method: PayoutMethod;
  status: PayoutStatus;
  fee: number;
  netAmount: number;
  processedAt?: string | null;
  createdAt: string;
}

export interface SubscriptionRefund {
  id: string;
  subscriptionId: string;
  paymentId: string;
  amount: number;
  refundType: 'FULL' | 'PARTIAL';
  reason: string;
  status: string;
  createdAt: string;
}
