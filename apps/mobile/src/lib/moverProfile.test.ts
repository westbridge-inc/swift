import { describe, expect, it } from 'vitest';
import { resolveMoverProfile, unwrapOptionalMoverProfile } from './moverProfile';

describe('unwrapOptionalMoverProfile', () => {
  it('permits kind fallback only for a definitive missing profile', async () => {
    await expect(unwrapOptionalMoverProfile(Promise.reject({ response: { status: 404 } })))
      .resolves.toBeNull();
  });

  it('does not cross mover authority on transient or server failures', async () => {
    const failure = { response: { status: 503 } };
    await expect(unwrapOptionalMoverProfile(Promise.reject(failure))).rejects.toBe(failure);
    await expect(unwrapOptionalMoverProfile(Promise.reject(new Error('network down'))))
      .rejects.toThrow('network down');
  });
});

describe('resolveMoverProfile', () => {
  const driver = { id: 'driver', isOnline: false, currentRideId: null };
  const rider = { id: 'rider', isOnline: false, currentOrderId: null };

  it('prioritizes exactly one active job and then exactly one online profile', () => {
    expect(resolveMoverProfile({
      activeRole: 'DRIVER',
      lastMoverRole: 'DRIVER',
      driver,
      rider: { ...rider, currentOrderId: 'delivery' },
    }).kind).toBe('RIDER');
    expect(resolveMoverProfile({
      activeRole: 'RIDER',
      lastMoverRole: 'RIDER',
      driver: { ...driver, isOnline: true },
      rider,
    }).kind).toBe('DRIVER');
  });

  it('uses specific current authority, then durable mover memory', () => {
    expect(resolveMoverProfile({ activeRole: 'RIDER', lastMoverRole: 'DRIVER', driver, rider }).kind)
      .toBe('RIDER');
    expect(resolveMoverProfile({ activeRole: 'CUSTOMER', lastMoverRole: 'DRIVER', driver, rider }).kind)
      .toBe('DRIVER');
  });

  it('uses a single profile but refuses to guess an ambiguous legacy dual account', () => {
    expect(resolveMoverProfile({ activeRole: 'MOVER', lastMoverRole: null, driver: null, rider }).kind)
      .toBe('RIDER');
    expect(resolveMoverProfile({ activeRole: 'MOVER', lastMoverRole: null, driver, rider }))
      .toMatchObject({ kind: null, profile: null, ambiguous: true });
  });
});
