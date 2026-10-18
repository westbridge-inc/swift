import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('../services/jobRinger', () => ({ startJobRing: vi.fn() }));

import { ringWhileForeground, type AppStateLike } from './useJobRing';

// [RINGER] The ring sounds only while the app is in the foreground.
function fakeAppState(initial: string) {
  let listener: ((state: string) => void) | null = null;
  const remove = vi.fn();
  const appState: AppStateLike = {
    currentState: initial,
    addEventListener: (_type, fn) => { listener = fn; return { remove }; },
  };
  return { appState, remove, emit: (state: string) => listener?.(state) };
}

describe('ringWhileForeground', () => {
  it('rings now, stops when the app leaves the foreground, rings again on return, and stops for good on cleanup', () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const { appState, remove, emit } = fakeAppState('active');
    const cleanup = ringWhileForeground(start, appState);
    expect(start).toHaveBeenCalledTimes(1);
    emit('background');
    expect(stop).toHaveBeenCalledTimes(1);
    emit('inactive');
    expect(stop).toHaveBeenCalledTimes(1);
    emit('active');
    expect(start).toHaveBeenCalledTimes(2);
    emit('active');
    expect(start).toHaveBeenCalledTimes(2);
    cleanup();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('opened in the background: silent until the app comes to the front', () => {
    const start = vi.fn(() => vi.fn());
    const { appState, emit } = fakeAppState('background');
    ringWhileForeground(start, appState);
    expect(start).not.toHaveBeenCalled();
    emit('active');
    expect(start).toHaveBeenCalledTimes(1);
  });
});
