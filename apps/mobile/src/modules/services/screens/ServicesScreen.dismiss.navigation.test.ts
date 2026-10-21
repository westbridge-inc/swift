/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U12] The REAL ServicesScreen, drawn by a real React renderer: a
// request goes out, the "Request sent" popup opens, and "View my jobs" must
// close the popup in its own tick and open My jobs only after the modal's
// teardown (#910's law, kit/after-dismiss). Closing and navigating in one
// tick can leave the popup's invisible window over My jobs, eating every tap.
// The animation frames are held by hand so "same tick" is exact.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  navigate: vi.fn(),
  request: { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown },
  typeDescription: null as null | ((text: string) => void),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const View = (p: any) => h('div', { 'data-testid': p.testID }, p.children);
  return {
    View, ScrollView: View,
    TextInput: (p: any) => { fx.typeDescription = p.onChangeText; return h('div', { 'data-testid': 'description' }, p.value); },
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {} },
    Platform: { OS: 'android' },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  const T = (p: any) => h('span', null, p.children);
  const button = (p: any) => h('button', { type: 'button', disabled: !!(p.disabled || p.loading), onClick: p.disabled || p.loading ? undefined : p.onPress }, p.label);
  return {
    Card: Box, DecorativeIcon: Box, Screen: Box, T, PopupTitle: T, RatingMeta: () => null, Pictogram: () => null, IconChip: () => null,
    TonePill: (p: any) => h('span', null, p.label), LoadingBlock: () => h('p', null, 'loading'),
    EmptyState: (p: any) => h('div', null, p.title),
    Header: (p: any) => h('header', null, p.title, p.right),
    LinkText: button, PillButton: button, Chip: button,
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
  };
});
vi.mock('../../../hooks', () => ({
  useServiceProviders: () => ({
    data: { providers: [{ id: 'prov-1', trade: 'plumber', tradeLabel: 'Plumber', bio: null, portfolioPhotos: [], displayRating: null, averageRating: 0, totalRatings: 0, selfSkilled: false, certified: false, badges: [] }] },
    isFetching: false, isError: false, refetch: vi.fn(),
  }),
  useRequestJob: () => fx.request,
}));
vi.mock('../useServiceCatalog', () => ({
  useServiceCatalog: () => ({
    isPending: false, isError: false, refetch: vi.fn(),
    data: { categories: [{ id: 'plumber', label: 'Plumber', group: 'HOME_AND_TRADES', modes: ['QUOTE_JOB'], quoteRequestsEnabled: true }] },
  }),
}));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (select: (s: { isAuthenticated: boolean; promptLogin: () => void }) => unknown) => select({ isAuthenticated: true, promptLogin: vi.fn() }),
}));
vi.mock('../serviceProviderEntry', () => ({ enterServiceProvider: vi.fn() }));

import { ServicesScreen } from './ServicesScreen';

const navigation = { navigate: fx.navigate, goBack: vi.fn() };
const frames: Array<() => void> = [];
const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
const real = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const buttonNamed = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;
const dialog = () => host.querySelector('[role="dialog"]');
async function click(el: Element | null) {
  expect(el, 'the control is on screen').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
}
async function runFrames() {
  for (let i = 0; i < 2; i++) {
    const due = frames.splice(0);
    await act(async () => { due.forEach((go) => go()); });
  }
}
async function sendRequest() {
  await act(async () => root.render(React.createElement(ServicesScreen, { navigation })));
  await click(buttonNamed('Plumber'));
  await click(buttonNamed('Request'));
  expect(fx.typeDescription, 'the description box is on screen').toBeTypeOf('function');
  await act(async () => { fx.typeDescription!('The kitchen tap leaks under the sink'); });
  await click(buttonNamed('Send request'));
  expect(fx.request.mutate).toHaveBeenCalledTimes(1);
  expect(dialog()?.textContent).toContain('Request sent');
}

beforeEach(() => {
  vi.clearAllMocks();
  frames.length = 0;
  g.requestAnimationFrame = (fn: () => void) => { frames.push(fn); return frames.length; };
  g.cancelAnimationFrame = () => undefined;
  fx.typeDescription = null;
  fx.request.mutate.mockImplementation((_input: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  g.requestAnimationFrame = real.raf;
  g.cancelAnimationFrame = real.caf;
});

describe('[UI-SWEEP U12] "Request sent" closes before My jobs opens', () => {
  it('View my jobs: the popup is gone in its own tick; My jobs opens only after the teardown frames', async () => {
    await sendRequest();
    await click(buttonNamed('View my jobs'));
    expect(dialog()).toBeNull();
    expect(fx.navigate).not.toHaveBeenCalled();
    await runFrames();
    expect(fx.navigate).toHaveBeenCalledExactlyOnceWith('ServiceJobs');
  });

  it('Done closes the popup and goes nowhere', async () => {
    await sendRequest();
    await click(buttonNamed('Done'));
    expect(dialog()).toBeNull();
    await runFrames();
    expect(fx.navigate).not.toHaveBeenCalled();
  });
});
