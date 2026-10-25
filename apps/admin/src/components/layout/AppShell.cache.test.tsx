import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { Providers } from '@/app/providers';
import IntegrityPage from '@/app/integrity/page';
import { mockApi } from '@/test/test-utils';
import { logout, verifyOtpLogin } from '@/lib/api';

// [L06 #1556 · ASTRA S1] The console's page cache belongs to ONE signed-in
// admin. A SUPER_ADMIN reads restricted integrity flags, signs out, and an
// ordinary ADMIN signs in on the same tab inside the cache's fresh window: the
// second account must never see the first account's cached answer, and its own
// read must reach the server (which refuses it). Real Providers, real shell,
// real page; synthetic HTTP only.

const nav = vi.hoisted(() => ({ pathname: '/integrity', replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <aside>Navigation</aside> }));
vi.mock('./Header', () => ({ Header: () => <header>Header</header> }));

function api() {
  const state = { actor: 'SUPER_ADMIN', me: 0, flags: 0 };
  mockApi(({ url }) => {
    const id = state.actor === 'SUPER_ADMIN' ? 'synthetic-a' : 'synthetic-b';
    if (url.pathname === '/api/v1/auth/me') {
      state.me++;
      return { body: { success: true, data: { user: { id, activeRole: state.actor, roles: [state.actor], status: 'ACTIVE' }, sessionId: state.actor, client: 'admin-web' } } };
    }
    if (url.pathname === '/api/v1/auth/logout') return { body: { success: true } };
    if (url.pathname === '/api/v1/auth/verify-otp') {
      return { body: { success: true, data: { isNewUser: false, session: 'cookie', user: { id: 'synthetic-b', activeRole: 'ADMIN', roles: ['ADMIN'], status: 'ACTIVE' } } } };
    }
    if (url.pathname === '/api/v1/admin/integrity/flags') {
      state.flags++;
      if (state.actor !== 'SUPER_ADMIN') return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } } };
      return { body: { success: true, data: { flags: [{
        id: 'synthetic-flag', algo: 'ALG-34', subjectType: 'CUSTOMER', subjectId: 'synthetic-subject', outcome: 'UNCORROBORATED',
        sentence: 'Synthetic restricted flag', inputs: {}, configVersion: 'synthetic-version', createdAt: '2026-10-07T00:00:00Z',
      }], windowDays: 7 } } };
    }
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
  return state;
}

it('sign-out then sign-in as another admin: the cached restricted answer is gone and the new read reaches the server', async () => {
  nav.pathname = '/integrity';
  const state = api();
  const view = render(<Providers><AppShell><IntegrityPage /></AppShell></Providers>);
  expect(await screen.findByText('Synthetic restricted flag')).toBeTruthy();

  await logout();
  nav.pathname = '/login';
  view.rerender(<Providers><AppShell><p>Login</p></AppShell></Providers>);
  expect(screen.queryByText('Synthetic restricted flag')).toBeNull();

  state.actor = 'ADMIN';
  await verifyOtpLogin('synthetic-phone', 'synthetic-code');
  nav.pathname = '/integrity';
  view.rerender(<Providers><AppShell><IntegrityPage /></AppShell></Providers>);
  await waitFor(() => expect(screen.getByRole('group', { name: 'Algorithm' })).toBeTruthy());
  await waitFor(() => expect(state.flags, 'the second account asked the server itself').toBe(2));
  expect(state.me).toBe(2);
  expect(screen.queryByText('Synthetic restricted flag')).toBeNull();
});

it('another account signed in from a different tab (no visit to /login): the next page check drops the cache too', async () => {
  nav.pathname = '/integrity';
  const state = api();
  const view = render(<Providers><AppShell><IntegrityPage /></AppShell></Providers>);
  expect(await screen.findByText('Synthetic restricted flag')).toBeTruthy();

  state.actor = 'ADMIN';
  nav.pathname = '/integrity/';
  view.rerender(<Providers><AppShell><IntegrityPage /></AppShell></Providers>);
  await waitFor(() => expect(screen.getByRole('group', { name: 'Algorithm' })).toBeTruthy());
  await waitFor(() => expect(state.flags).toBe(2));
  expect(screen.queryByText('Synthetic restricted flag')).toBeNull();
});
