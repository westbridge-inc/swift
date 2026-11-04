/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [BUG-HUNT F13] The code had nowhere to go: no sign-up form has a field for it, and the route that takes it had no
// caller. A friend enters it here, and the words say so.
const fx = vi.hoisted(() => ({
  profile: { customer: { referralCode: 'SWIFT123', referredCount: 0 } } as Record<string, any>,
  redeem: vi.fn(),
  refetch: vi.fn(),
  share: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  return { View: ({ children }: any) => R.createElement('div', null, children), Share: { share: fx.share } };
});
vi.mock('@swift/ui', () => ({ space: new Proxy({}, { get: () => 8 }) }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return {
    Card: Box, T: Box, Screen: Box, Header: () => null, IconChip: () => null, LoadingBlock: () => null, ErrorState: () => null,
    PillButton: ({ label, onPress, disabled }: any) => R.createElement('button', { type: 'button', onClick: onPress, disabled }, label),
    LabeledInput: ({ label, value, onChangeText }: any) => R.createElement('input', { 'aria-label': label, value, onChange: (e: any) => onChangeText(e.target.value) }),
  };
});
vi.mock('../../../kit/toast', () => ({ toast: { show: fx.toast } }));
vi.mock('../../../hooks/customer', () => ({ useProfile: () => ({ data: fx.profile, isLoading: false, isError: false, refetch: fx.refetch }) }));
vi.mock('../../../services/api', () => ({ customerApi: { redeemReferral: fx.redeem } }));

import { InviteFriendsScreen } from './InviteFriendsScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  fx.profile = { customer: { referralCode: 'SWIFT123', referredCount: 0 } };
  for (const f of [fx.redeem, fx.refetch, fx.share, fx.toast]) f.mockReset();
  fx.share.mockResolvedValue({});
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const draw = () => act(async () => root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(InviteFriendsScreen))));
const type = async (value: string) => {
  const input = host.querySelector('input')!;
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  await act(async () => { set.call(input, value); input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event('input', { bubbles: true })); });
};
const tap = (label: string) => act(async () => [...host.querySelectorAll('button')].find((el) => el.textContent === label)!.click());

describe('[BUG-HUNT F13] Invite Friends', () => {
  it('no words about a sign-up field nobody has, or a trust reward nothing reads', async () => {
    await draw();
    expect(host.textContent).not.toMatch(/at signup|build trust/i);
    expect(host.textContent).toContain('A friend enters it here after they join');
    await tap('Share My Code');
    expect(fx.share.mock.calls[0]![0].message).toContain('open Invite Friends and enter my code SWIFT123');
    expect(fx.share.mock.calls[0]![0].message).not.toMatch(/when you sign up/);
  });

  it('a friend enters a code: it goes to the server, trimmed, and the screen reads again', async () => {
    fx.redeem.mockResolvedValue({ data: { success: true } });
    await draw();
    await type('  FRIEND9 ');
    await tap('Enter code');
    expect(fx.redeem).toHaveBeenCalledWith('FRIEND9');
    expect(fx.toast).toHaveBeenCalledWith('Your friend’s code is saved.');
    expect(fx.refetch).toHaveBeenCalled();
  });

  it('the server’s refusal is what the person reads', async () => {
    fx.redeem.mockRejectedValue({ response: { data: { error: { message: 'That referral code wasn’t found' } } } });
    await draw();
    await type('NOPE');
    await tap('Enter code');
    expect(fx.toast).toHaveBeenCalledWith('That referral code wasn’t found');
  });

  it('empty: nothing to send', async () => {
    await draw();
    expect([...host.querySelectorAll('button')].find((el) => el.textContent === 'Enter code')!.disabled).toBe(true);
  });

  it('someone who has already used a code is not offered the door', async () => {
    fx.profile = { customer: { referralCode: 'SWIFT123', referredCount: 0, referredBy: 'c1' } };
    await draw();
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).not.toContain('Enter code');
  });
});
