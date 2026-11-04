import { describe, expect, it } from 'vitest';
import { canDriverHandbackRide, driverStepFailedWords } from './driverRide';

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

describe('[G05] a failed driver step says why', () => {
  it('in the server\'s words', () => {
    expect(driverStepFailedWords({ response: { data: { error: { message: 'Incorrect PIN. 3 attempt(s) remaining.' } } } })).toBe('Incorrect PIN. 3 attempt(s) remaining.');
  });
  it('with no answer, what to try: never nothing', () => {
    expect(driverStepFailedWords(new Error('Network Error'))).toBe('That didn’t go through. Check your connection and try again.');
    expect(driverStepFailedWords({ response: { data: { error: { message: ' ' } } } })).toBe('That didn’t go through. Check your connection and try again.');
    expect(driverStepFailedWords(undefined)).toBe('That didn’t go through. Check your connection and try again.');
  });
});
