import type { TaxiLifecycleNotificationData } from '@swift/types';

/** Call only from a producer that has established the taxi order context. */
export function taxiNotificationData(id: string, extra: { status?: string; kind?: string; etaMinutes?: number; eta?: number } = {}, audience: 'customer' | 'earner' = 'customer'): TaxiLifecycleNotificationData & Record<string, unknown> {
  return { ...extra, orderType: 'TAXI', rideId: id, orderId: id, audience };
}
