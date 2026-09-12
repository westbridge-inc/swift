import { describe, expect, it } from 'vitest';
import { canDriverHandbackRide } from './driverRide';

describe('driver ride handback visibility', () => {
  it.each(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'])(
    'allows %s before the passenger handoff',
    (status) => {
      expect(canDriverHandbackRide({ status, ridePinVerified: false, ridePinVerifiedAt: null })).toBe(true);
    },
  );

  it.each(['PENDING', 'RIDE_IN_PROGRESS', 'DELIVERED', 'COMPLETED', 'CANCELLED', null])(
    'does not offer handback in %s',
    (status) => {
      expect(canDriverHandbackRide({ status })).toBe(false);
    },
  );

  it('fails safe when either persisted PIN-verification fact says custody crossed', () => {
    expect(canDriverHandbackRide({ status: 'DRIVER_ARRIVED', ridePinVerified: true })).toBe(false);
    expect(canDriverHandbackRide({ status: 'DRIVER_ARRIVED', ridePinVerifiedAt: '2026-09-12T12:00:00Z' })).toBe(false);
  });

  it('does not offer an action without a ride', () => {
    expect(canDriverHandbackRide(null)).toBe(false);
    expect(canDriverHandbackRide(undefined)).toBe(false);
  });
});
