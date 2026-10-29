/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [Row 3 · force update] The REAL gate and screen, drawn by a real React
// renderer. A build older than the API's minimum is covered by "Update Swift"
// with its own store's link; everything uncertain shows the app as usual; the
// check runs again when the app comes back to the screen. Only native drawing,
// the platform, the build number and transport are fakes.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  os: 'ios' as string,
  get: vi.fn(),
  openURL: vi.fn(() => Promise.resolve()),
  appState: [] as Array<(state: string) => void>,
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    View: (p: any) => h('div', { 'data-testid': p.testID }, p.children),
    Modal: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    Platform: { get OS() { return fx.os; } },
    AppState: { addEventListener: (_: string, cb: (state: string) => void) => { fx.appState.push(cb); return { remove: () => { fx.appState = fx.appState.filter((x) => x !== cb); } }; } },
    Linking: { openURL: fx.openURL },
  };
});
vi.mock('@swift/ui', () => ({ color: { surface: {} }, space: {} }));
vi.mock('../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    Screen: (p: any) => h('section', { 'data-testid': p.testID }, p.children),
    T: (p: any) => h(p.onPress ? 'a' : 'span', { 'data-testid': p.testID, onClick: p.onPress }, p.children),
    PillButton: (p: any) => h('button', { type: 'button', 'data-testid': p.testID, onClick: p.onPress }, p.label),
  };
});
vi.mock('./SwiftLogo', () => ({ SwiftMark: () => null }));
vi.mock('../services/api', () => ({ api: { get: fx.get } }));
vi.mock('../stores/authStore', () => ({ useAuthStore: (select: (s: { countryCode: string | null }) => unknown) => select({ countryCode: 'GY' }) }));

import { UpdateRequiredGate, nativeBuildNumber } from './UpdateRequiredGate';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const answer = (ios: number | null, android: number | null) => ({ data: { success: true, data: { ios: { minBuild: ios }, android: { minBuild: android } } } });
async function draw(build: string | null) {
  await act(async () => root.render(React.createElement(UpdateRequiredGate, { readBuild: () => build })));
  await act(async () => { await Promise.resolve(); });
}
const blocked = () => host.querySelector('[data-testid="update-required"]') !== null;
const click = async (testId: string) => act(async () => { (host.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click(); await Promise.resolve(); });

beforeEach(() => {
  fx.os = 'ios';
  fx.get.mockReset();
  fx.openURL.mockReset().mockImplementation(() => Promise.resolve());
  fx.appState = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('a build below the minimum is asked to update', () => {
  it('iPhone build 11 under a minimum of 12: the whole app is covered, and "Update Swift" opens the App Store page', async () => {
    fx.get.mockResolvedValue(answer(12, null));
    await draw('11');
    expect(fx.get).toHaveBeenCalledWith('/public/app-version');
    expect(blocked()).toBe(true);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain('Update Swift');
    expect(host.textContent).toContain('from the App Store');
    await click('update-required-open-store');
    expect(fx.openURL).toHaveBeenCalledWith('https://apps.apple.com/app/id6815507102');
  });

  it('Android version code 7 under a minimum of 8 opens Google Play', async () => {
    fx.os = 'android';
    fx.get.mockResolvedValue(answer(null, 8));
    await draw('7');
    expect(blocked()).toBe(true);
    expect(host.textContent).toContain('from Google Play');
    await click('update-required-open-store');
    expect(fx.openURL).toHaveBeenCalledWith('https://play.google.com/store/apps/details?id=gy.swift.app');
  });

  it('a store that will not open says what to do instead', async () => {
    fx.get.mockResolvedValue(answer(12, null));
    fx.openURL.mockImplementation(() => Promise.reject(new Error('no store app')));
    await draw('11');
    await click('update-required-open-store');
    expect(host.querySelector('[data-testid="update-required-store-failed"]')?.textContent).toBe('Couldn’t open the App Store. Open it yourself and search for Swift.');
  });

  it('it hides SOS, so the verified emergency number stays one tap away', async () => {
    fx.get.mockResolvedValue(answer(12, null));
    await draw('11');
    expect(host.querySelector('[data-testid="update-required-emergency"]')?.textContent).toBe('In an emergency, call 911.');
    await click('update-required-emergency');
    expect(fx.openURL).toHaveBeenCalledWith('tel:911');
  });
});

describe('everything uncertain shows the app', () => {
  it.each([
    ['the build meets the minimum', answer(12, null), '12'],
    ['no minimum is set (the launch state)', answer(null, null), '11'],
    ['the other platform has the minimum', answer(null, 8), '7'],
    ['the build number cannot be read', answer(12, null), null],
  ])('%s', async (_why, policy, build) => {
    fx.get.mockResolvedValue(policy);
    await draw(build);
    expect(fx.get).toHaveBeenCalledOnce();
    expect(blocked()).toBe(false);
    expect(host.innerHTML).toBe('');
  });

  it('the check fails (offline, or an API without the route)', async () => {
    fx.get.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }));
    await draw('11');
    expect(blocked()).toBe(false);
  });
});

describe('it asks again when the app comes back to the screen', () => {
  it('a minimum raised while the app was in the background applies on return; a failed re-check keeps the answer', async () => {
    fx.get.mockResolvedValue(answer(null, null));
    await draw('11');
    expect(blocked()).toBe(false);
    fx.get.mockResolvedValue(answer(12, null));
    await act(async () => { fx.appState.forEach((cb) => cb('background')); await Promise.resolve(); });
    expect(fx.get).toHaveBeenCalledOnce();
    await act(async () => { fx.appState.forEach((cb) => cb('active')); await Promise.resolve(); });
    expect(fx.get).toHaveBeenCalledTimes(2);
    expect(blocked()).toBe(true);
    fx.get.mockRejectedValue(new Error('Network Error'));
    await act(async () => { fx.appState.forEach((cb) => cb('active')); await Promise.resolve(); });
    expect(blocked()).toBe(true);
  });
});

describe('the build number', () => {
  it('is the native module’s, and a binary without the module reads unknown instead of crashing', () => {
    expect(nativeBuildNumber(() => ({ nativeBuildVersion: '12' }))).toBe('12');
    expect(nativeBuildNumber(() => ({ nativeBuildVersion: null }))).toBeNull();
    expect(nativeBuildNumber(() => { throw new Error("Cannot find native module 'ExpoApplication'"); })).toBeNull();
  });
});
