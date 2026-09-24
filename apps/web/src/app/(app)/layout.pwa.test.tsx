import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';

const state = vi.hoisted(() => ({ pathname: '/order', replace: vi.fn(), sessionProbe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useRouter: () => ({ replace: state.replace }) }));
vi.mock('@/lib/auth', () => ({ sessionProbe: state.sessionProbe }));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

// ---------------------------------------------------------------------------
// [PWA-1] The customer shell as an installed app: clear of the notch and the
// home bar, and offering the install card on the home page — including when
// the browser's install event lands while sign-in is still being checked.
// ---------------------------------------------------------------------------

function installEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, { prompt: vi.fn().mockResolvedValue(undefined) });
  return event;
}

const card = () => screen.queryByRole('complementary', { name: 'Install Swift' });

beforeEach(() => {
  state.pathname = '/order';
  state.sessionProbe.mockResolvedValue({ ok: true });
});

describe('[PWA-1] the customer shell, installed', () => {
  it('pads the header below the status bar and ends the page above the home bar', async () => {
    const { container } = render(<AppLayout><p>Home</p></AppLayout>);
    await screen.findByText('Home');
    expect(container.querySelector('header')?.className).toContain('pt-[env(safe-area-inset-top)]');
    expect(container.querySelector('main')?.className).toContain('env(safe-area-inset-bottom)');
  });

  it('catches the install event while sign-in is still being checked, and offers it once home renders', async () => {
    let signIn: (_value: { ok: boolean }) => void = () => undefined;
    state.sessionProbe.mockReturnValue(new Promise((resolve) => { signIn = resolve; }));
    render(<AppLayout><p>Home</p></AppLayout>);
    expect(screen.queryByText('Home')).toBeNull();

    const event = installEvent();
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();

    await act(async () => { signIn({ ok: true }); });
    await screen.findByText('Home');
    expect(card()).not.toBeNull();
  });

  it('never lays the card over the cart', async () => {
    state.pathname = '/cart';
    render(<AppLayout><p>Cart</p></AppLayout>);
    await screen.findByText('Cart');
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()).toBeNull();
  });
});
