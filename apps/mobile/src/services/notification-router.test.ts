import { describe, it, expect, vi } from 'vitest';

// Pure routing-table test — the expo/notifications + navigation modules are
// side-effect imports the table doesn't need; mock them to nothing.
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponseAsync: () => Promise.resolve(null),
}));
vi.mock('../navigation/navigationRef', () => ({
  navigationRef: { isReady: () => false },
  safeNavigate: () => false,
}));

import { destinationFor } from './notification-router';

// The tap-router's single source of truth [first-open 2.4]: every payload
// kind lands exactly where its journey lives; unknown payloads return null
// (the app opens normally — never a guess, never a crash).

describe('destinationFor — the tap table', () => {
  it('queue outcomes and ride kinds land on Taxi', () => {
    expect(destinationFor({ kind: 'ride_queue_matched', orderId: 'o1' })).toEqual({ screen: 'Taxi' });
    expect(destinationFor({ kind: 'ride_queue_expired' })).toEqual({ screen: 'Taxi' });
    expect(destinationFor({ kind: 'ride_sos_ack' })).toEqual({ screen: 'Taxi' });
  });

  it('anything carrying an orderId lands on that order’s tracking screen', () => {
    expect(destinationFor({ kind: 'prep_ready', orderId: 'abc' })).toEqual({ screen: 'Delivery', params: { orderId: 'abc' } });
    expect(destinationFor({ orderId: 'xyz' })).toEqual({ screen: 'Delivery', params: { orderId: 'xyz' } });
  });

  it('booking reminders land on Activity; unknowns open the app normally', () => {
    expect(destinationFor({ kind: 'booking_reminder', refId: 'j1' })).toEqual({ screen: 'HomeTabs', params: { screen: 'Activity' } });
    expect(destinationFor({ kind: 'billing_topup' })).toBeNull();
    expect(destinationFor({})).toBeNull();
    expect(destinationFor(null)).toBeNull();
  });

  it('ride kinds outrank the orderId fallback (a taxi push opens Taxi, not Delivery)', () => {
    expect(destinationFor({ kind: 'ride_queue_matched', orderId: 'ride-order' })).toEqual({ screen: 'Taxi' });
  });
});
