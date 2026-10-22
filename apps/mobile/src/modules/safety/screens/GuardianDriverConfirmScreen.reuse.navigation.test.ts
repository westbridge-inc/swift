/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [UI-SWEEP U10 · REVIEW-F #1902 S3-1] A trip-guardian push for a NEW check
// re-uses the driver's open check screen (navigate + pop, or the screen is
// already on top): React Navigation hands the SAME mounted screen the new
// cycle and nonce. The answer used to survive the switch, so a driver who had
// confirmed the last check saw "Confirmed" and no button for the new one, and
// the passenger's check escalated although the driver was willing to answer.
// The REAL GuardianDriverConfirmScreen and the real request parser on a real
// React renderer; only native drawing, the kit and the network are stand-ins.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  route: { name: 'GuardianDriverConfirm', params: {} as Record<string, unknown> },
  mutate: vi.fn(),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  return { View: (p: any) => R.createElement('div', null, p.children) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useRoute: () => fx.route, useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock('@swift/ui', () => ({ color: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  return {
    Screen: (p: any) => h('div', null, p.children), Header: (p: any) => h('header', null, p.title),
    T: (p: any) => h('span', null, p.children),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
  };
});
vi.mock('../../../hooks/safety', () => ({
  useGuardianDriverConfirm: () => ({ mutate: fx.mutate, isPending: false }),
}));

import { GuardianDriverConfirmScreen } from './GuardianDriverConfirmScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();
const labels = () => Array.from(host.querySelectorAll('button')).map((b) => b.textContent);
/** React Navigation re-renders the SAME mounted screen with the new route. */
async function show(params: Record<string, unknown>) {
  fx.route = { ...fx.route, params };
  await act(async () => root.render(React.createElement(GuardianDriverConfirmScreen)));
}
async function answer() {
  const yes = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Yes, the trip is fine')!;
  await act(async () => { yes.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('[UI-SWEEP U10 S3-1] a new guardian check on the open check screen can be answered', () => {
  it('after confirming check 1, check 2 shows its own question and button', async () => {
    fx.mutate.mockImplementation((_vars, cb) => cb.onSuccess());
    await show({ cycleId: 'cycle-1', nonce: 'n-1', respondBy: inAnHour() });
    await answer();
    expect(labels(), 'check 1 is answered').toEqual(['Back to my job']);

    await show({ cycleId: 'cycle-2', nonce: 'n-2', respondBy: inAnHour() });

    expect(labels(), 'check 2 can be answered').toEqual(['Yes, the trip is fine']);
    expect(host.textContent).not.toContain('Back to my job');
    await answer();
    expect(fx.mutate).toHaveBeenLastCalledWith({ cycleId: 'cycle-2', nonce: 'n-2' }, expect.anything());
  });

  it('a late reply to check 1 never lands on check 2', async () => {
    let late: { onSuccess: () => void } | undefined;
    fx.mutate.mockImplementation((_vars, cb) => { late = cb; });
    await show({ cycleId: 'cycle-1', nonce: 'n-1', respondBy: inAnHour() });
    await answer();
    await show({ cycleId: 'cycle-2', nonce: 'n-2', respondBy: inAnHour() });
    await act(async () => late!.onSuccess());
    expect(labels(), 'check 2 still waits for its own answer').toEqual(['Yes, the trip is fine']);
  });

  it('the SAME check handed again keeps its answer (no reset without a new check)', async () => {
    fx.mutate.mockImplementation((_vars, cb) => cb.onSuccess());
    const params = { cycleId: 'cycle-1', nonce: 'n-1', respondBy: inAnHour() };
    await show(params);
    await answer();
    await show({ ...params });
    expect(labels()).toEqual(['Back to my job']);
  });
});
