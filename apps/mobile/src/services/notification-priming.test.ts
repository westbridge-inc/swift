import { beforeEach, describe, expect, it, vi } from 'vitest';

// [STORE-ALERT 18 Oct 2026] The store iPhone in the owner's live test was
// never asked for notifications: the card showed only at three moments, once
// per install, and never when a store signed in. Earner dashboards now ask
// while the OS still can, once per app session, whatever the install flag.

const mocks = vi.hoisted(() => {
  const values = new Map<string, boolean>();
  class FakeMMKV {
    getBoolean(key: string) { return values.get(key); }
    set(key: string, value: boolean) { values.set(key, value); }
    delete(key: string) { values.delete(key); }
  }
  return { values, FakeMMKV };
});
vi.mock('react-native-mmkv', () => ({ MMKV: mocks.FakeMMKV }));

import {
  markPrimeAsked,
  maybePrimeEarnerNotifications,
  maybePrimeNotifications,
  resetPrimingForTests,
  usePrimeStore,
} from './notification-priming';

beforeEach(() => {
  vi.useFakeTimers();
  resetPrimingForTests();
});

const shown = () => usePrimeStore.getState().visibleMoment;

describe('[STORE-ALERT] earner dashboards ask while the OS still can', () => {
  it('a store dashboard on an undetermined phone shows the card, even after the install flag was set', async () => {
    markPrimeAsked(); // e.g. "Not now" on a customer order long ago
    await expect(maybePrimeEarnerNotifications('store_dashboard', async () => 'ask')).resolves.toBe(true);
    vi.advanceTimersByTime(600);
    expect(shown()).toBe('store_dashboard');
  });

  it('once per app session per dashboard: a re-mount does not nag', async () => {
    await maybePrimeEarnerNotifications('store_dashboard', async () => 'ask');
    vi.advanceTimersByTime(600);
    usePrimeStore.getState().dismiss();
    await expect(maybePrimeEarnerNotifications('store_dashboard', async () => 'ask')).resolves.toBe(false);
    vi.advanceTimersByTime(600);
    expect(shown()).toBeNull();
    // The mover dashboard is its own moment.
    await expect(maybePrimeEarnerNotifications('mover_dashboard', async () => 'ask')).resolves.toBe(true);
    vi.advanceTimersByTime(600);
    expect(shown()).toBe('mover_dashboard');
  });

  it('never on a phone that is already granted, or refused for good (Settings is the strip’s job)', async () => {
    await expect(maybePrimeEarnerNotifications('store_dashboard', async () => 'granted')).resolves.toBe(false);
    await expect(maybePrimeEarnerNotifications('mover_dashboard', async () => 'settings')).resolves.toBe(false);
    vi.advanceTimersByTime(600);
    expect(shown()).toBeNull();
  });

  it('the customer moment keeps its once-per-install rule', () => {
    maybePrimeNotifications('customer_order');
    vi.advanceTimersByTime(600);
    expect(shown()).toBe('customer_order');
    usePrimeStore.getState().dismiss();
    markPrimeAsked();
    maybePrimeNotifications('customer_order');
    vi.advanceTimersByTime(600);
    expect(shown()).toBeNull();
  });
});
