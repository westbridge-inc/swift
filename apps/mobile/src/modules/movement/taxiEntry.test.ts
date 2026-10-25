import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardAuthContinuation,
  flushAuthContinuation,
  rootRouteForAuthContinuation,
} from '../../navigation/authContinuation';
import { signInForTaxi } from './taxiEntry';

// [Q4, DS256 F1] Signing in from the taxi door re-keys the root navigator; the
// rider must land back on Taxi, once, after every root gate, never on Home.
describe('taxi authentication continuation', () => {
  beforeEach(() => discardAuthContinuation());

  it('queues Taxi before opening sign-in, and resumes it once after every root gate', () => {
    const promptLogin = vi.fn();
    const deliver = vi.fn(() => true);

    signInForTaxi(promptLogin);
    expect(promptLogin).toHaveBeenCalledOnce();

    expect(flushAuthContinuation({ isAuthenticated: false, entryGate: 'auth', intent: 'customer' }, deliver)).toBe('waiting');
    // A newly signed-in account may still owe the mandatory selfie.
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'selfie', intent: 'customer' }, deliver)).toBe('waiting');
    expect(deliver).not.toHaveBeenCalled();

    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'customer' }, deliver)).toBe('delivered');
    expect(deliver).toHaveBeenCalledWith({ screen: 'Taxi' });
    expect(rootRouteForAuthContinuation({ screen: 'Taxi' })).toEqual({ screen: 'Main', params: { screen: 'Taxi' } });

    // One sign-in resumes Taxi once, never on later renders.
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'customer' }, deliver)).toBe('none');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('never resumes Taxi inside an earner or advertiser navigator', () => {
    const deliver = vi.fn(() => true);
    signInForTaxi(vi.fn());
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'mover' }, deliver)).toBe('discarded');
    expect(deliver).not.toHaveBeenCalled();
  });
});
