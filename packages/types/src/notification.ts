export enum NotificationType {
  ORDER_UPDATE = 'ORDER_UPDATE',
  PROMOTION = 'PROMOTION',
  SUBSCRIPTION_REMINDER = 'SUBSCRIPTION_REMINDER',
  SUBSCRIPTION_EXPIRED = 'SUBSCRIPTION_EXPIRED',
  PAYMENT_RECEIVED = 'PAYMENT_RECEIVED',
  EARNING_AVAILABLE = 'EARNING_AVAILABLE',
  RATING_RECEIVED = 'RATING_RECEIVED',
  SYSTEM_ANNOUNCEMENT = 'SYSTEM_ANNOUNCEMENT',
  CHAT_MESSAGE = 'CHAT_MESSAGE',
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  isRead: boolean;
  readAt?: string | null;
  createdAt: string;
}

/** Opaque taxi lifecycle identity; never includes passenger/vehicle details. */
export interface TaxiLifecycleNotificationData {
  orderType: 'TAXI';
  rideId: string;
  orderId: string;
  audience: 'customer' | 'earner';
  status?: string;
  kind?: string;
  etaMinutes?: number;
  eta?: number;
}
