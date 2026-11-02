import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// [FLOW-QA F31] A private page that finds no session sends the person to sign in WITH the page they asked for,
// so sign-in brings them back there (login/page.tsx honours a next inside their own area).
const fx = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: fx.replace, push: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({ sessionProbe: vi.fn().mockResolvedValue({ ok: false }), restoreSession: vi.fn().mockResolvedValue({ ok: false }) }));

import { useConsoleSession } from './console-session';

function Gate() { useConsoleSession(); return null; }

describe('[FLOW-QA F31] private pages keep ?next', () => {
  it('no session on /dashboard/orders?page=2: /login?next=/dashboard/orders?page=2', async () => {
    window.history.replaceState(null, '', '/dashboard/orders?page=2');
    render(<Gate />);
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/dashboard/orders?page=2')}`));
    window.history.replaceState(null, '', '/');
  });
});

describe('[FLOW-QA F15] a refresh refused for too many checks offers signing in again', () => {
  it('says what happened and links to sign-in with this page as next; never a sign-out', async () => {
    const { ConsoleUnreachable } = await import('./console-session');
    const { render: r, screen } = await import('@testing-library/react');
    window.history.replaceState(null, '', '/portal/documents');
    r(<ConsoleUnreachable onRetry={() => {}} rateLimited />);
    expect(screen.getByText('Too many sign-in checks from your network right now.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe(`/login?next=${encodeURIComponent('/portal/documents')}`);
    expect(screen.queryByText(/can.t be reached/)).toBeNull();
    window.history.replaceState(null, '', '/');
  });
});
