/// <reference lib="dom" />
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error the workspace web package owns the test-only DOM renderer.
import { createRoot } from 'react-dom/client';

const fx = vi.hoisted(() => ({ openURL: vi.fn(), toast: vi.fn() }));
vi.mock('react-native', async () => {
  const R = await import('react');
  return { Linking: { openURL: fx.openURL }, Pressable: ({ children, onPress, style, accessibilityLabel }: any) =>
    R.createElement('button', { onClick: onPress, style, 'aria-label': accessibilityLabel }, children) };
});
vi.mock('@swift/ui', () => ({ color: { text: { primary: 'black' }, surface: { base: 'white' } }, radius: { sm: 4 }, space: { sm: 8, xs: 4 } }));
vi.mock('../kit', async () => {
  const R = await import('react');
  return { T: ({ children, style }: any) => R.createElement('span', { style }, children) };
});
vi.mock('../kit/toast', () => ({ toast: { show: fx.toast } }));
import { RouteAttribution } from './RouteAttribution';

const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); });
async function render() {
  root = createRoot(host);
  await act(async () => root.render(React.createElement(RouteAttribution, { top: 80 })));
  return host.querySelector('button')!;
}
describe('routing credit stays readable and leads to its licence', () => {
  it('qualifies the routing data, leaves native map credit alone, and opens the OSM licence', async () => {
    fx.openURL.mockResolvedValue(undefined);
    const credit = await render();
    expect(credit.textContent).toContain('Routing: © OpenStreetMap contributors');
    expect(credit.style.position).toBe('absolute');
    expect(credit.style.top).toBe('80px');
    expect(credit.style.minHeight).toBe('44px');
    expect(credit.style.backgroundColor).toBe('white');
    expect(host.querySelector('span')!.style.color).toBe('black');
    await act(async () => credit.click());
    expect(fx.openURL).toHaveBeenCalledWith('https://www.openstreetmap.org/copyright');
  });
  it('an unavailable browser gives a message without an unhandled rejection', async () => {
    fx.openURL.mockRejectedValue(new Error('unavailable'));
    const credit = await render();
    await act(async () => credit.click());
    expect(fx.toast).toHaveBeenCalledWith('Couldn’t open the data licence. Try again.');
  });
});
