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
