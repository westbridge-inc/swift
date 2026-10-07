import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptSession } from '@/lib/auth';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { CustomerSessionProvider } from '@/components/customer-session';
import ProfilePage from '@/app/(app)/account/profile/page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/account/profile' }));
const profile = { id: 'email-owner', firstName: 'Synthetic', lastName: 'Profile', phone: '+5920000000', email: 'old@example.test' };
const ok = (data: unknown) => ({ body: { success: true, data } });
const required = { status: 403, body: { error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it is you first.' } } };
let calls: ApiRequest[];
let verified: boolean;
let rejectRetry: boolean;
let finishVerify: (() => void) | undefined;
let holdVerify: boolean;

beforeEach(() => {
  adoptSession(profile.id); calls = []; verified = false; rejectRetry = false; holdVerify = false; finishVerify = undefined;
  mockApi(async (request) => {
    calls.push(request);
    const path = request.url.pathname;
    const body = request.init?.body ? JSON.parse(String(request.init.body)) : {};
    if (path.endsWith('/profile') && request.method === 'GET') return ok(profile);
    if (path.endsWith('/profile') && request.method === 'PUT') return verified && !rejectRetry ? ok({ ...profile, ...body }) : required;
    if (path.endsWith('/consent')) return ok({ consents: [] });
    if (path.endsWith('/auth/step-up')) return ok({ sentTo: '+592•••0000', validForSeconds: 300 });
    if (path.endsWith('/auth/step-up/verify')) {
      if (body.code !== '123456') return { status: 400, body: { error: { code: 'INVALID_CODE', message: 'That code is not right' } } };
      if (holdVerify) await new Promise<void>((resolve) => { finishVerify = resolve; });
      verified = true; return ok({ validForSeconds: 600 });
    }
    throw new Error(`Unexpected ${request.method} ${path}`);
  });
});
async function begin() {
  const rendered = renderWithQuery(<CustomerSessionProvider value={{ status: 'signed-in', scope: profile.id, epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined }}><ProfilePage /></CustomerSessionProvider>);
  const email = await screen.findByLabelText('Email');
  await rendered.user.clear(email); await rendered.user.type(email, 'new@example.test');
  await rendered.user.click(screen.getByRole('button', { name: 'Save details' }));
  await screen.findByRole('button', { name: 'Send confirmation code' });
  return rendered;
}
async function enterCode(user: Awaited<ReturnType<typeof begin>>['user'], code = '123456') {
  await user.click(screen.getByRole('button', { name: 'Send confirmation code' }));
  await user.type(await screen.findByLabelText('Confirmation code'), code);
  await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
}
const writes = () => calls.filter((r) => r.method === 'PUT');

describe('email confirmation on the web', () => {
  it('confirms the cookie session, then retries the unchanged payload exactly once', async () => {
    const { user } = await begin();
    expect(writes()).toHaveLength(1);
    expect((screen.getByLabelText('Email') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    await enterCode(user);
    await screen.findByText('Your details are saved.');
    expect(writes()).toHaveLength(2);
    expect(writes()[0]!.init?.body).toBe(writes()[1]!.init?.body);
    expect(JSON.parse(String(writes()[1]!.init?.body)).email).toBe('new@example.test');
    expect(calls.every((r) => r.init?.credentials === 'include')).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('a wrong code does not retry or claim success, and a corrected code can finish', async () => {
    const { user } = await begin(); await enterCode(user, '000000');
    await screen.findByText('That code is not right'); expect(writes()).toHaveLength(1);
    expect(screen.queryByText('Your details are saved.')).toBeNull();
    await user.clear(screen.getByLabelText('Confirmation code')); await user.type(screen.getByLabelText('Confirmation code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm and save' }));
    await screen.findByText('Your details are saved.'); expect(writes()).toHaveLength(2);
  });
  it('cancellation leaves the draft editable and sends no retry', async () => {
    const { user } = await begin(); await user.click(screen.getByRole('button', { name: 'Cancel confirmation' }));
    expect(writes()).toHaveLength(1); expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('Email') as HTMLInputElement).closest('fieldset')?.disabled).toBe(false);
    expect(screen.queryByText('Your details are saved.')).toBeNull();
  });
  it.each(['account', 'same-account-login', 'unmount'])('%s invalidates a verification already in flight', async (change) => {
    const view = await begin(); holdVerify = true; await enterCode(view.user);
    await waitFor(() => expect(finishVerify).toBeDefined());
    await act(async () => {
      if (change === 'unmount') view.unmount(); else adoptSession(change === 'account' ? 'other-owner' : profile.id);
      finishVerify?.();
    });
    expect(writes()).toHaveLength(1);
    expect(screen.queryByText('Your details are saved.')).toBeNull();
  });
  it.each(['account', 'same-account-login'])('%s dismisses pending confirmation before another request can be sent', async (change) => {
    await begin();
    await act(async () => { adoptSession(change === 'account' ? 'other-owner' : profile.id); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((r) => r.url.pathname.includes('/auth/step-up'))).toHaveLength(0);
    expect(writes()).toHaveLength(1);
  });
  it('a second step-up refusal is shown without a retry loop or false success', async () => {
    const { user } = await begin(); rejectRetry = true; await enterCode(user);
    await screen.findByRole('alert'); expect(writes()).toHaveLength(2);
    expect(screen.queryByText('Your details are saved.')).toBeNull();
  });
});
