/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [CALL-RELAY-ON · owner 6 Nov 2026] "A call should not look like a scam."
// Guyana networks show only the number for an incoming call (no caller name),
// so every screen with "Call via Swift" says which number Swift calls from,
// read from the server (GET /calls/config), and offers to copy it so it can be
// saved as "Swift". Copy uses React Native's own clipboard (lib/clipboard.ts,
// already in the store builds): no new native module, so it ships over the air.
// Saving straight to Contacts would need a native contacts module: not done.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  config: vi.fn(),
  copyText: vi.fn((_text: string) => true),
  toast: { show: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'data-testid': p.testID, 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress }, p.children);
  return { View, Pressable, Text: View, StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@swift/ui', () => ({ space: { xs: 4, sm: 8, md: 12 } }));
vi.mock('../kit', async () => {
  const R = await import('react');
  const T = (p: any) => R.createElement('span', { 'data-selectable': p.selectable ? 'true' : undefined, role: p.accessibilityRole }, p.children);
  return { T };
});
vi.mock('../kit/toast', () => ({ toast: fx.toast }));
vi.mock('../lib/clipboard', () => ({ copyText: (text: string) => fx.copyText(text) }));
vi.mock('../services/api', () => ({ callsApi: { config: () => fx.config() } }));

import { SwiftCallNumberTip } from './SwiftCallNumberTip';
import { resetCallConfigForTests } from '../hooks/useCallParty';

const CALLER = '+18785550123';
const ON = { data: { success: true, data: { enabled: true, callerId: CALLER } } };
const OFF = { data: { success: true, data: { enabled: false, callerId: null } } };

let host: HTMLDivElement;
let root: { render(node: React.ReactNode): void; unmount(): void };

async function draw(): Promise<void> {
  await act(async () => { root.render(React.createElement(SwiftCallNumberTip)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const copyButton = () => host.querySelector('[aria-label="Copy Swift\'s call number"]') as HTMLElement | null;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  resetCallConfigForTests();
  fx.config.mockReset();
  fx.copyText.mockReset().mockReturnValue(true);
  Object.values(fx.toast).forEach((f) => f.mockReset());
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('[CALL-RELAY-ON] the caller line under "Call via Swift"', () => {
  it('calls not through Swift (the launch state) or the switch unreadable: nothing at all', async () => {
    fx.config.mockResolvedValue(OFF);
    await draw();
    expect(host.textContent).toBe('');
    resetCallConfigForTests();
    fx.config.mockRejectedValue(new Error('offline'));
    await draw();
    expect(host.textContent).toBe('');
  });

  it('calls through Swift: the server\'s number, spaced to read, selectable, with a Copy button', async () => {
    fx.config.mockResolvedValue(ON);
    await draw();
    expect(host.textContent).toContain('Swift calls you from +1 878 555 0123 (save it as Swift).');
    expect(host.querySelector('[data-selectable="true"]')?.textContent).toContain('+1 878 555 0123');
    expect(copyButton()?.textContent).toBe('Copy number');
  });

  it('Copy puts the number itself on the clipboard and says to save it as Swift', async () => {
    fx.config.mockResolvedValue(ON);
    await draw();
    await act(async () => { copyButton()!.click(); });
    expect(fx.copyText).toHaveBeenCalledWith(CALLER);
    expect(fx.toast.success).toHaveBeenCalledWith('Number copied', 'Save it in your contacts as Swift.');
  });

  it('a phone that cannot copy is told how to copy by hand, never a silent tap', async () => {
    fx.config.mockResolvedValue(ON);
    fx.copyText.mockReturnValue(false);
    await draw();
    await act(async () => { copyButton()!.click(); });
    expect(fx.toast.success).not.toHaveBeenCalled();
    expect(fx.toast.show).toHaveBeenCalledWith('Press and hold the number to copy it.');
  });
});
