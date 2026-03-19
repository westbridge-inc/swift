export enum SubscriptionType {
  DELIVERY_RIDER = 'DELIVERY_RIDER',
  COURIER_RIDER = 'COURIER_RIDER',
  TAXI_DRIVER = 'TAXI_DRIVER',
  RESTAURANT = 'RESTAURANT',
  SUPERMARKET = 'SUPERMARKET',
}

export enum SubscriptionStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  PAST_DUE = 'PAST_DUE',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
  TRIAL = 'TRIAL',
}

export const SUBSCRIPTION_RATES: Record<SubscriptionType, number> = {
  [SubscriptionType.DELIVERY_RIDER]: 10000,
  [SubscriptionType.COURIER_RIDER]: 20000,
  [SubscriptionType.TAXI_DRIVER]: 20000,
  [SubscriptionType.RESTAURANT]: 20000,
  [SubscriptionType.SUPERMARKET]: 20000,
};

export interface Subscription {
  id: string;
  riderId?: string | null;
  driverId?: string | null;
  vendorId?: string | null;
  type: SubscriptionType;
  status: SubscriptionStatus;
  weeklyRate: number;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextBillingDate: string;
  isInGracePeriod: boolean;
  gracePeriodEnd?: string | null;
  isTrialActive: boolean;
  trialEndDate?: string | null;
  autoRenew: boolean;
  lastPaymentDate?: string | null;
  failedAttempts: number;
  feeWaived: boolean;
  createdAt: string;
  updatedAt: string;
}
