import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
const fx = vi.hoisted(() => ({ pathname: '/verification', replace: vi.fn(), probe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => fx.pathname, useRouter: () => fx }));
vi.mock('@/lib/api', () => ({ sessionProbe: fx.probe }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <aside>Admin navigation</aside> }));
vi.mock('./Header', () => ({ Header: () => <header>Admin header</header> }));
beforeEach(() => { fx.pathname = '/verification'; vi.resetAllMocks(); });
describe('admin shell role authority', () => {
 it.each([{ roles: ['CUSTOMER'] }, { roles: ['RIDER'] }, { roles: ['DRIVER'] }, { roles: ['VENDOR_OWNER'] }, { roles: [] }, { roles: null }, { roles: undefined }, { roles: ['ADMIN_MAYBE'] }])('refuses session $roles before showing the workspace', async ({ roles }) => {
  fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-user', roles } });
  render(<AppShell><p>Protected workspace</p></AppShell>);
  await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
  expect(screen.queryByText('Protected workspace')).toBeNull();
  expect(screen.queryByText('Admin navigation')).toBeNull();
 });
 it.each(['ADMIN','SUPER_ADMIN'])('allows a server-attested %s role', async (role) => {
  fx.probe.mockResolvedValue({ ok: true, user: { id: 'synthetic-admin', roles: [role] } });
  render(<AppShell><p>Protected workspace</p></AppShell>);
  expect(await screen.findByText('Protected workspace')).toBeTruthy();
  expect(fx.replace).not.toHaveBeenCalled();
 });
 it('a role lost between pages hides the workspace while the new session check runs', async () => {
  fx.probe.mockResolvedValueOnce({ ok: true, user: { id: 'synthetic-admin', roles: ['ADMIN'] } });
  const workspace = vi.fn(({ label }: { label: string }) => <p>{label}</p>);
  const Workspace = workspace;
  const view=render(<AppShell><Workspace label="First workspace" /></AppShell>);
  await screen.findByText('First workspace');
  let resolve!: (_value: unknown) => void;
  fx.probe.mockImplementationOnce(() => new Promise((done) => { resolve=done; }));
  fx.pathname='/orders';
  workspace.mockClear();
  view.rerender(<AppShell><Workspace label="Second workspace" /></AppShell>);
  expect(workspace).not.toHaveBeenCalled();
  expect(screen.queryByText('Second workspace')).toBeNull();
  resolve({ ok: true, user: { id: 'synthetic-admin', roles: ['CUSTOMER'] } });
  await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/login'));
  expect(screen.queryByText('Second workspace')).toBeNull();
 });
});
