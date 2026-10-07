import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';

const fx = vi.hoisted(() => ({ pathname: '/verification', replace: vi.fn(), probe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => fx.pathname, useRouter: () => fx }));
vi.mock('@/lib/api', () => ({ sessionProbe: fx.probe }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <aside>Admin navigation</aside> }));
vi.mock('./Header', () => ({ Header: () => <header>Admin header</header> }));
beforeEach(() => { fx.pathname = '/verification'; vi.resetAllMocks(); });

it('returning from login cannot reuse the old workspace approval while a new session check runs', async () => {
  fx.probe.mockResolvedValueOnce({ ok: true, user: { id: 'synthetic-admin', roles: ['ADMIN'] } });
  const workspace = vi.fn(({ label }: { label: string }) => <p>{label}</p>);
  const Workspace = workspace;
  const view = render(<AppShell><Workspace label="First workspace" /></AppShell>);
  await screen.findByText('First workspace');
  fx.pathname = '/login';
  view.rerender(<AppShell><p>Public login</p></AppShell>);
  expect(screen.getByText('Public login')).toBeTruthy();
  expect(fx.probe).toHaveBeenCalledOnce();

  let resolve!: (value: unknown) => void;
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
