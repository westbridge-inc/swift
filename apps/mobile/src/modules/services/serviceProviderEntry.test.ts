import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discardAuthContinuation,
  flushAuthContinuation,
  rootRouteForAuthContinuation,
} from '../../navigation/authContinuation';
import {
  enterServiceProvider,
  serviceProviderScreenMode,
} from './serviceProviderEntry';

describe('service-provider authentication continuation', () => {
  beforeEach(() => discardAuthContinuation());

  it('sends a guest to the existing login flow and resumes at the provider profile', () => {
    const promptLogin = vi.fn();
    const navigate = vi.fn();
    const deliver = vi.fn(() => true);

    expect(enterServiceProvider({ isAuthenticated: false, promptLogin, navigate }))
      .toBe('login-requested');
    expect(promptLogin).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(serviceProviderScreenMode(false)).toBe('sign-in-required');

    expect(flushAuthContinuation(
      { isAuthenticated: false, entryGate: 'auth', intent: 'customer' },
      deliver,
    )).toBe('waiting');
    expect(deliver).not.toHaveBeenCalled();

    // A newly authenticated account may still owe the mandatory selfie. The
    // destination remains pending until that final root gate has completed.
    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'selfie', intent: 'customer' },
      deliver,
    )).toBe('waiting');
    expect(deliver).not.toHaveBeenCalled();

    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'main', intent: 'customer' },
      deliver,
    )).toBe('delivered');
    expect(deliver).toHaveBeenCalledWith({ screen: 'ServiceProvider' });
    expect(rootRouteForAuthContinuation({ screen: 'ServiceProvider' })).toEqual({
      screen: 'Main',
      params: { screen: 'ServiceProvider' },
    });
    expect(serviceProviderScreenMode(true)).toBe('profile-ready');

    // One login can resume the destination once, never on later renders.
    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'main', intent: 'customer' },
      deliver,
    )).toBe('none');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('keeps the authenticated entry behavior direct and queues no login intent', () => {
    const promptLogin = vi.fn();
    const navigate = vi.fn();
    const deliver = vi.fn(() => true);

    expect(enterServiceProvider({ isAuthenticated: true, promptLogin, navigate })).toBe('opened');
    expect(navigate).toHaveBeenCalledWith('ServiceProvider');
    expect(promptLogin).not.toHaveBeenCalled();
    expect(serviceProviderScreenMode(true)).toBe('profile-ready');
    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'main', intent: 'customer' },
      deliver,
    )).toBe('none');
  });

  it('never resumes a customer destination inside an unrelated role stack', () => {
    const promptLogin = vi.fn();
    const deliver = vi.fn(() => true);

    enterServiceProvider({
      isAuthenticated: false,
      promptLogin,
      navigate: vi.fn(),
    });

    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'main', intent: 'mover' },
      deliver,
    )).toBe('discarded');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('retains the one-shot destination when navigation is not ready yet', () => {
    enterServiceProvider({
      isAuthenticated: false,
      promptLogin: vi.fn(),
      navigate: vi.fn(),
    });

    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'main', intent: 'customer' },
      () => false,
    )).toBe('retry');
    expect(flushAuthContinuation(
      { isAuthenticated: true, entryGate: 'main', intent: 'customer' },
      () => true,
    )).toBe('delivered');
  });
});
