import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [UI-SWEEP U23] Both partner consoles sent ANY failed session check to the
// sign-in page: a server hiccup (5xx) or a dropped connection signed a working
// partner out of the screen they were on. Only the server saying "no session"
// goes to /login; "unreachable" says so and checks again on request.
// [UI-SWEEP U22] The consoles had no offline notice at all.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ probe: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace, push: vi.fn() }), usePathname: () => '/portal' }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: fx.probe, setSelectedStore: vi.fn() };
});
vi.mock('@/lib/vendor-api', () => ({ getStores: vi.fn(() => new Promise(() => {})) }));

import { PortalShell } from './portal-shell';
import { DashboardShell } from '../dashboard/dashboard-shell';

beforeEach(() => { fx.probe.mockReset(); fx.replace.mockReset(); });

const shells = [['the earner office', PortalShell], ['the store dashboard', DashboardShell]] as const;

describe('[U23] a check that could not reach Swift is not a sign-out', () => {
  it.each(shells)('%s says Swift cannot be reached, stays put, and checks again on request', async (_name, Shell) => {
    fx.probe.mockResolvedValueOnce({ ok: false, unreachable: true }).mockResolvedValueOnce({ ok: true, user: { id: 'u1', firstName: 'Sample' } });
    render(<Shell><p>console body</p></Shell>);
    expect(await screen.findByText("Swift can't be reached right now.")).toBeTruthy();
    expect(fx.replace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('console body')).toBeTruthy();
    expect(fx.probe).toHaveBeenCalledTimes(2);
    expect(fx.replace).not.toHaveBeenCalled();
  });

  it.each(shells)('%s still sends a browser with no session to sign in', async (_name, Shell) => {
    fx.probe.mockResolvedValue({ ok: false });
    render(<Shell><p>console body</p></Shell>);
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText("Swift can't be reached right now.")).toBeNull();
  });
});

describe('[U22] the consoles say when the browser is offline', () => {
  it('the earner office shows the phone\'s offline words when the connection drops', async () => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'u1' } });
    render(<PortalShell><p>console body</p></PortalShell>);
    await screen.findByText('console body');
    expect(screen.queryByText('You’re offline.')).toBeNull();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(await screen.findByText('You’re offline.')).toBeTruthy();
    expect(screen.getByText('Some things may not load until you’re back online.')).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(screen.queryByText('You’re offline.')).toBeNull());
  });
});
