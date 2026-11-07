import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell';

// [ADMIN-ROLE] The signed-in chip names the admin role the account HOLDS — what
// the server acts under — never the phone app's mode. Synthetic ids only.

const fx = vi.hoisted(() => ({ pathname: '/verification', replace: vi.fn(), probe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => fx.pathname, useRouter: () => fx }));
vi.mock('@/lib/api', () => ({ sessionProbe: fx.probe }));
vi.mock('./Sidebar', () => ({ Sidebar: ({ role }: { role?: string | null }) => <aside>{`chip:${role ?? 'none'}`}</aside> }));
vi.mock('./Header', () => ({ Header: () => <header>Admin header</header> }));

function renderShell(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<>{ui}</>, { wrapper: Wrapper });
}

beforeEach(() => { fx.pathname = '/verification'; vi.resetAllMocks(); });

describe('[ADMIN-ROLE] the console names the held admin role', () => {
  it.each([
    { activeRole: 'RIDER', roles: ['SUPER_ADMIN', 'CUSTOMER', 'MOVER', 'RIDER'], chip: 'SUPER_ADMIN' },
    { activeRole: 'CUSTOMER', roles: ['CUSTOMER', 'ADMIN'], chip: 'ADMIN' },
    { activeRole: 'SUPER_ADMIN', roles: ['SUPER_ADMIN', 'CUSTOMER'], chip: 'SUPER_ADMIN' },
    { activeRole: 'ADMIN', roles: ['ADMIN'], chip: 'ADMIN' },
  ])('mode $activeRole with roles $roles shows $chip', async ({ activeRole, roles, chip }) => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-admin', activeRole, roles } });
    renderShell(<AppShell><p>Workspace</p></AppShell>);
    await screen.findByText('Workspace');
    expect(screen.getAllByText(`chip:${chip}`).length).toBeGreaterThan(0);
    expect(screen.queryByText(`chip:${activeRole}`) === null || activeRole === chip).toBe(true);
  });
});
