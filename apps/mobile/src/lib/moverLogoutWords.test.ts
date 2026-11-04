import { describe, expect, it } from 'vitest';
import {
  LOGOUT_NOTHING_IN_HAND, LOGOUT_ON_THE_WAY_BACK, LOGOUT_WITH_GOODS, LOGOUT_WITH_PASSENGER, moverLogoutBody,
} from './moverLogoutWords';

describe('[BUG-HUNT F18] the log-out box says what will happen', () => {
  it.each(['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'])('goods in the bag (%s): suspended until the delivery is finished', (status) => {
    expect(moverLogoutBody([{ status }])).toBe(LOGOUT_WITH_GOODS);
    expect(LOGOUT_WITH_GOODS).toMatch(/suspended until that delivery is finished/);
    expect(LOGOUT_WITH_GOODS).toMatch(/comes back by itself/);
  });

  it('a passenger in the car: a person reviews it, and the box says so', () => {
    expect(moverLogoutBody([{ status: 'RIDE_IN_PROGRESS' }])).toBe(LOGOUT_WITH_PASSENGER);
    expect(moverLogoutBody([{ status: 'DRIVER_ARRIVED', ridePinVerified: true }])).toBe(LOGOUT_WITH_PASSENGER);
    expect(LOGOUT_WITH_PASSENGER).toMatch(/until a person at Swift reviews it/);
    expect(LOGOUT_WITH_PASSENGER).not.toMatch(/by itself/);
  });

  it('goods on the way back: a person reviews it', () => {
    expect(moverLogoutBody([{ status: 'RETURNING' }])).toBe(LOGOUT_ON_THE_WAY_BACK);
    expect(LOGOUT_ON_THE_WAY_BACK).not.toMatch(/by itself/);
  });

  it.each(['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE'])('not picked up yet (%s): the plain box', (status) => {
    expect(moverLogoutBody([{ status }])).toBe(LOGOUT_NOTHING_IN_HAND);
  });

  it('no job at all: the plain box', () => {
    expect(moverLogoutBody([])).toBe(LOGOUT_NOTHING_IN_HAND);
    expect(moverLogoutBody([null, undefined])).toBe(LOGOUT_NOTHING_IN_HAND);
  });

  it('a stacked run: any leg in the bag counts, not only the first', () => {
    expect(moverLogoutBody([{ status: 'RIDER_ASSIGNED' }, { status: 'PICKED_UP' }])).toBe(LOGOUT_WITH_GOODS);
  });
});
