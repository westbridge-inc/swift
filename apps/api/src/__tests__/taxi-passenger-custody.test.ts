import { describe, expect, it } from 'vitest';
import type { OrderStatus } from '@prisma/client';
import { hasTaxiPassengerCustody } from '../modules/rides/passenger-custody';

describe('canonical taxi passenger-custody predicate', () => {
  it.each([
    ['DRIVER_ASSIGNED', false, null, false],
    ['DRIVER_EN_ROUTE', false, null, false],
    ['DRIVER_ARRIVED', false, null, false],
    ['DRIVER_ARRIVED', true, null, true],
    ['DRIVER_ARRIVED', false, new Date('2026-08-08T00:00:00Z'), true],
    ['RIDE_IN_PROGRESS', false, null, true],
  ] as const)(
    '%s / verified=%s / verifiedAt=%s => custody=%s',
    (status, ridePinVerified, ridePinVerifiedAt, expected) => {
      expect(hasTaxiPassengerCustody({
        status: status as OrderStatus,
        ridePinVerified,
        ridePinVerifiedAt,
      })).toBe(expected);
    },
  );
});
