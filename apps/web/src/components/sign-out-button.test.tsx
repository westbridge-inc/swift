import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Owner: "logging out of any account — the confirmation 'should we log you
// out', like every other app. Implement it code-wise safely."
//
// SignOutButton is the one web sign-out control: the business dashboard, the
// earner portal and the customer account page all use it. These drive the real
// component in happy-dom. lib/auth's logout() (the server revoke) and the
// router are the only stand-ins.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
const auth = vi.hoisted(() => ({ logout: vi.fn<() => Promise<void>>() }));

vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.mock('@/lib/auth', () => ({ logout: auth.logout }));

import { SignOutButton } from './sign-out-button';

const BODY = 'New orders stop showing in this browser until you sign in again.';

function renderControl() {
  render(
    <SignOutButton className="sidebar-link" body={BODY} redirectTo="/login">
      Sign out
    </SignOutButton>,
  );
  return screen.getByRole('button', { name: 'Sign out' });
}

const ask = () => screen.queryByRole('dialog', { name: 'Sign out of Swift?' });

beforeEach(() => {
  auth.logout.mockResolvedValue(undefined);
});

describe('the sign-out control asks first', () => {
  it('opens the ask, says what signing out costs here, and ends nothing', async () => {
    const user = userEvent.setup();
    await user.click(renderControl());

    const dialog = ask();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog!).getByText(BODY)).toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
    // The safe choice holds the focus.
    expect(document.activeElement).toBe(within(dialog!).getByRole('button', { name: 'Stay signed in' }));
  });

  it('"Stay signed in" closes the ask, ends nothing and hands focus back to the control', async () => {
    const user = userEvent.setup();
    await user.click(renderControl());

    await user.click(within(ask()!).getByRole('button', { name: 'Stay signed in' }));

    expect(ask()).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sign out' }));
  });

  it('Escape closes the ask and ends nothing', async () => {
    const user = userEvent.setup();
    await user.click(renderControl());

    await user.keyboard('{Escape}');

    expect(ask()).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('Enter pressed twice on the control does not sign out', async () => {
    const user = userEvent.setup();
    renderControl().focus();

    await user.keyboard('{Enter}');
    expect(ask()).not.toBeNull();
    await user.keyboard('{Enter}');

    expect(ask()).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
  });
});

describe('"Sign out"', () => {
  it('ends the session once, even clicked twice before a re-render, then leaves', async () => {
    const user = userEvent.setup();
    await user.click(renderControl());
    const confirm = within(ask()!).getByRole('button', { name: 'Sign out' });

    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(auth.logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login'));
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it('leaves only after the server has ended the session, and cannot be taken back meanwhile', async () => {
    let finish!: () => void;
    auth.logout.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    await user.click(renderControl());

    await user.click(within(ask()!).getByRole('button', { name: 'Sign out' }));
    await user.keyboard('{Escape}');

    const dialog = ask();
    expect(dialog, 'the ask stays while the server works').not.toBeNull();
    expect(within(dialog!).getByRole('button', { name: 'Signing out…' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog!).getByRole('button', { name: 'Stay signed in' }).hasAttribute('disabled')).toBe(true);
    expect(nav.replace).not.toHaveBeenCalled();

    await act(async () => finish());

    expect(nav.replace).toHaveBeenCalledExactlyOnceWith('/login');
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });
});
