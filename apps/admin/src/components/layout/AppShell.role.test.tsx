import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell';

// [L06 #1556] The admin workspace mounts only after the SERVER attests an
// ADMIN or SUPER_ADMIN role, on every page; anything else goes to /login with
// nothing of the workspace shown. Synthetic ids only.

const fx = vi.hoisted(() => ({ pathname: '/verification', replace: vi.fn(), probe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => fx.pathname, useRouter: () => fx }));
vi.mock('@/lib/api', () => ({ sessionProbe: fx.probe }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <aside>Admin navigation</aside> }));
vi.mock('./Header', () => ({ Header: () => <header>Admin header</header> }));

function renderShell(ui: ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<>{ui}</>, { wrapper: Wrapper });
}

beforeEach(() => { fx.pathname = '/verification'; vi.resetAllMocks(); });

describe('[L06 #1556] admin shell role authority', () => {
  it.each([
    { roles: ['CUSTOMER'] }, { roles: ['RIDER'] }, { roles: ['DRIVER'] }, { roles: ['VENDOR_OWNER'] },
    { roles: [] }, { roles: null }, { roles: undefined }, { roles: ['ADMIN_MAYBE'] },
  ])('refuses session $roles before showing the workspace', async ({ roles }) => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-user', activeRole: 'CUSTOMER', roles } });
    renderShell(<AppShell><p>Protected workspace</p></AppShell>);
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Protected workspace')).toBeNull();
    expect(screen.queryByText('Admin navigation')).toBeNull();
  });

  it('refuses a failed session check the same way', async () => {
    fx.probe.mockResolvedValue({ ok: false });
    renderShell(<AppShell><p>Protected workspace</p></AppShell>);
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Protected workspace')).toBeNull();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])('allows a server-attested %s role', async (role) => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-admin', activeRole: role, roles: [role] } });
    renderShell(<AppShell><p>Protected workspace</p></AppShell>);
    expect(await screen.findByText('Protected workspace')).toBeTruthy();
    expect(fx.replace).not.toHaveBeenCalled();
  });

  it('an admin role held as a second hat still counts (active role is something else)', async () => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-admin', activeRole: 'CUSTOMER', roles: ['CUSTOMER', 'ADMIN'] } });
    renderShell(<AppShell><p>Protected workspace</p></AppShell>);
    expect(await screen.findByText('Protected workspace')).toBeTruthy();
  });

  it('a role lost between pages hides the workspace while the new session check runs', async () => {
    fx.probe.mockResolvedValueOnce({ ok: true, user: { id: 'synthetic-admin', activeRole: 'ADMIN', roles: ['ADMIN'] } });
    const workspace = vi.fn(({ label }: { label: string }) => <p>{label}</p>);
    const Workspace = workspace;
    const view = renderShell(<AppShell><Workspace label="First workspace" /></AppShell>);
    await screen.findByText('First workspace');
    let resolve!: (_value: unknown) => void;
    fx.probe.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fx.pathname = '/orders';
    workspace.mockClear();
    view.rerender(<AppShell><Workspace label="Second workspace" /></AppShell>);
    expect(workspace).not.toHaveBeenCalled();
    expect(screen.queryByText('Second workspace')).toBeNull();
    resolve({ ok: true, user: { id: 'synthetic-admin', activeRole: 'CUSTOMER', roles: ['CUSTOMER'] } });
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Second workspace')).toBeNull();
  });

  it('returning from login cannot reuse the old workspace approval while a new session check runs', async () => {
    fx.probe.mockResolvedValueOnce({ ok: true, user: { id: 'synthetic-admin', activeRole: 'ADMIN', roles: ['ADMIN'] } });
    const workspace = vi.fn(({ label }: { label: string }) => <p>{label}</p>);
    const Workspace = workspace;
    const view = renderShell(<AppShell><Workspace label="First workspace" /></AppShell>);
    await screen.findByText('First workspace');
    fx.pathname = '/login';
    view.rerender(<AppShell><p>Public login</p></AppShell>);
    expect(screen.getByText('Public login')).toBeTruthy();
    expect(fx.probe).toHaveBeenCalledOnce();

    let resolve!: (_value: unknown) => void;
    fx.probe.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fx.pathname = '/verification';
    workspace.mockClear();
    view.rerender(<AppShell><Workspace label="Returned workspace" /></AppShell>);
    expect(workspace).not.toHaveBeenCalled();
    expect(screen.queryByText('Returned workspace')).toBeNull();
    resolve({ ok: false });
    await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('Returned workspace')).toBeNull();
  });

  it('the way to /login forgets every cached answer of the session that is ending', async () => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-admin', activeRole: 'ADMIN', roles: ['ADMIN'] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderShell(<AppShell><p>Workspace</p></AppShell>, client);
    await screen.findByText('Workspace');
    client.setQueryData(['synthetic-restricted'], { rows: ['synthetic'] });
    fx.pathname = '/login';
    view.rerender(<AppShell><p>Public login</p></AppShell>);
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
  });

  it('control: moving between pages as the same admin keeps the cache', async () => {
    fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-admin', activeRole: 'ADMIN', roles: ['ADMIN'] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderShell(<AppShell><p>First</p></AppShell>, client);
    await screen.findByText('First');
    client.setQueryData(['synthetic-kept'], { rows: ['synthetic'] });
    fx.pathname = '/orders';
    view.rerender(<AppShell><p>Second</p></AppShell>);
    await screen.findByText('Second');
    expect(client.getQueryData(['synthetic-kept'])).toEqual({ rows: ['synthetic'] });
  });
});
