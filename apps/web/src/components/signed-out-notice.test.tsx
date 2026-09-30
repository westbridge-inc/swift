import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { adoptSession, apiFetch, clearSession, getSessionPrincipal, logout, restoreSession, sessionProbe } from '@/lib/auth';
import { SignedOutNotice } from './customer-session';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';

const nav = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path }));
const message = 'You were signed out. Sign in again to see your orders.';
let refresh: number;
let calls: ApiRequest[];
const rejected = { status: 401, body: {} };
function api() { mockApi((r) => { calls.push(r); return r.url.pathname.endsWith('/auth/refresh') ? { status: refresh, body: {} } : rejected; }); }
beforeEach(() => { clearSession(); sessionStorage.clear(); nav.path = '/'; refresh = 401; calls = []; });

it('shows a rejected refresh notice once on the next screen, including after remount', async () => {
  adoptSession('test-person'); api();
  await expect(apiFetch('/api/v1/customer/orders', undefined, { redirectOnExpired: false })).rejects.toThrow('You were signed out. Please sign in again.');
  const view = render(<SignedOutNotice />);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([['GET', '/api/v1/customer/orders'], ['POST', '/api/v1/auth/refresh']]);
  expect(calls[1]!.init).toMatchObject({ credentials: 'include', headers: { 'X-Swift-Client': 'web' } });
  nav.path = '/account'; view.rerender(<SignedOutNotice />);
  expect(screen.queryByText(message)).toBeNull();
  view.unmount(); render(<SignedOutNotice />);
  expect(screen.queryByText(message)).toBeNull();
});

it('announces mid-visit rejection in the mounted shell and allows dismissal', async () => {
  adoptSession('test-person'); api(); render(<SignedOutNotice />);
  await act(async () => { await apiFetch('/api/v1/customer/orders', undefined, { redirectOnExpired: false }).catch(() => undefined); });
  expect(await screen.findByText(message)).toBeTruthy();
  await act(async () => { screen.getByRole('button', { name: 'Dismiss signed-out notice' }).click(); });
  expect(screen.queryByText(message)).toBeNull();
});

it('remembers a previously confirmed session across an expired probe and rejected restore', async () => {
  adoptSession('test-person'); api();
  await sessionProbe();
  await restoreSession();
  render(<SignedOutNotice />);
  expect(await screen.findByText(message)).toBeTruthy();
});

it.each([401, 200])('never shows after deliberate logout, even when logout needs refresh (%s)', async (code) => {
  adoptSession('test-person'); refresh = code; api();
  render(<SignedOutNotice />);
  await act(async () => { await logout(); });
  expect(screen.queryByText(message)).toBeNull();
});

it('does not label a first-time guest as signed out', async () => {
  api(); await restoreSession(); render(<SignedOutNotice />);
  expect(screen.queryByText(message)).toBeNull();
});

it.each([503, 429])('does not call an unavailable refresh (%s) a rejected session', async (code) => {
  adoptSession('test-person'); refresh = code; api();
  await apiFetch('/api/v1/customer/orders', undefined, { redirectOnExpired: false }).catch(() => undefined);
  render(<SignedOutNotice />); expect(screen.queryByText(message)).toBeNull();
});

it('does not announce a successful refresh or an offline refresh', async () => {
  adoptSession('test-person'); let reads = 0;
  mockApi((r) => r.url.pathname.endsWith('/auth/refresh') ? { body: {} } : ++reads === 1 ? rejected : { body: { success: true, data: [] } });
  await apiFetch('/api/v1/customer/orders'); render(<SignedOutNotice />);
  expect(screen.queryByText(message)).toBeNull();
  mockApi((r) => { if (r.url.pathname.endsWith('/auth/refresh')) throw new Error('Offline'); return rejected; });
  await act(async () => { await apiFetch('/api/v1/customer/orders', undefined, { redirectOnExpired: false }).catch(() => undefined); });
  expect(screen.queryByText(message)).toBeNull();
});

it('never lets a late rejected refresh sign out a new person', async () => {
  adoptSession('old-person'); let finish!: (_reply: ApiReply) => void;
  mockApi((r) => r.url.pathname.endsWith('/auth/refresh') ? new Promise((resolve) => { finish = resolve; }) : rejected);
  const request = apiFetch('/api/v1/customer/orders', undefined, { redirectOnExpired: false });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  adoptSession('new-person'); finish(rejected);
  await expect(request).rejects.toThrow('account changed');
  render(<SignedOutNotice />); expect(screen.queryByText(message)).toBeNull();
});


it('leaves a redirecting rejection for the login screen instead of consuming it on the departing screen', async () => {
  adoptSession('test-person'); api();
  const departing = render(<SignedOutNotice />);
  await act(async () => { await apiFetch('/api/v1/customer/orders').catch(() => undefined); });
  expect(screen.queryByText(message)).toBeNull();
  departing.unmount(); nav.path = '/login';
  const login = render(<SignedOutNotice />);
  expect(await screen.findByText(message)).toBeTruthy();
  login.unmount(); render(<SignedOutNotice />);
  expect(screen.queryByText(message)).toBeNull();
});


it('keeps a late successful session probe from resurrecting a rejected session and hiding its notice', async () => {
  adoptSession('test-person'); let finish!: (_reply: ApiReply) => void;
  mockApi((r) => r.url.pathname.endsWith('/auth/me') ? new Promise((resolve) => { finish = resolve; }) : rejected);
  const probe = sessionProbe();
  await apiFetch('/api/v1/customer/orders', undefined, { redirectOnExpired: false }).catch(() => undefined);
  render(<SignedOutNotice />); await screen.findByText(message);
  await act(async () => { finish({ body: { success: true, data: { user: { id: 'test-person' } } } }); await probe; });
  expect(getSessionPrincipal()).toBeNull();
  expect(screen.getByText(message)).toBeTruthy();
});

it('keeps a late failed probe from forgetting a newly adopted account', async () => {
  adoptSession('old-person'); let finish!: (_reply: ApiReply) => void;
  mockApi(() => new Promise((resolve) => { finish = resolve; }));
  const probe = sessionProbe(); adoptSession('new-person'); finish(rejected);
  expect((await probe).ok).toBe(true);
  expect(getSessionPrincipal()).toBe('new-person');
  render(<SignedOutNotice />); expect(screen.queryByText(message)).toBeNull();
});
