/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// [BUG-HUNT F10] A rider whose document lapses keeps the job in their hands, their fee and their earnings. The doors
// show on the screen they land on; a person signing up, with nothing of that kind, sees none of them.
const fx = vi.hoisted(() => ({
  navigate: vi.fn(),
  kind: 'RIDER' as string | null,
  profile: {} as unknown,
  job: null as unknown,
  fee: null as unknown,
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  return {
    View: ({ children }: any) => R.createElement('div', null, children),
    Pressable: ({ children, onPress }: any) => R.createElement('button', { type: 'button', onClick: onPress }, children),
  };
});
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: fx.navigate }) }));
vi.mock('@swift/ui', () => ({ space: new Proxy({}, { get: () => 8 }) }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  return { Card: Box, T: Box, SettingsRow: ({ label, onPress }: any) => R.createElement('button', { type: 'button', onClick: onPress }, label) };
});
vi.mock('../../hooks', () => ({
  useMoverKind: () => ({ kind: fx.kind, profile: fx.profile }),
  useActiveJob: () => ({ data: fx.job }),
  useMoverSubscription: () => ({ data: fx.fee }),
}));

import { MoverWorkDoors } from './MoverWorkDoors';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(fx, { kind: 'RIDER', profile: {}, job: null, fee: null });
  fx.navigate.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const draw = () => act(async () => root.render(React.createElement(MoverWorkDoors)));
const tap = (label: RegExp) => act(async () => [...host.querySelectorAll('button')].find((el) => label.test(el.textContent ?? ''))!.click());

describe('[BUG-HUNT F10] the way back to live work', () => {
  it('a lapsed rider with goods in the bag can open the job', async () => {
    fx.fee = { status: 'TRIAL' };
    fx.job = { id: 'o1', status: 'ARRIVED' };
    await draw();
    expect(host.textContent).toContain('You have a job in progress');
    await tap(/job in progress/);
    expect(fx.navigate).toHaveBeenCalledWith('ActiveJob');
  });

  it('a live job shows even for someone with no fee on record', async () => {
    fx.job = { id: 'o1', status: 'PICKED_UP' };
    await draw();
    expect(host.textContent).toContain('You have a job in progress');
    expect(host.textContent).not.toContain('Weekly fee');
  });

  it('someone Swift approved before can reach their fee and earnings', async () => {
    fx.fee = { status: 'ACTIVE' };
    await draw();
    await tap(/Weekly fee/);
    expect(fx.navigate).toHaveBeenLastCalledWith('WeeklyFee');
    await tap(/Earnings/);
    expect(fx.navigate).toHaveBeenLastCalledWith('Earnings');
    expect(host.textContent).not.toContain('job in progress');
  });

  it('the older verified flag counts, for a rider from before the weekly fee', async () => {
    fx.profile = { documentsVerified: true };
    await draw();
    expect(host.textContent).toContain('Weekly fee');
  });

  it('a person signing up sees none of it', async () => {
    await draw();
    expect(host.textContent).toBe('');
    fx.kind = null;
    await draw();
    expect(host.textContent).toBe('');
  });
});
