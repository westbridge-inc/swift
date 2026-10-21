import { beforeEach, describe, expect, it, vi } from 'vitest';

// [73] Every SOS call is bound to the account that pressed it: the session of
// that account travels with the request, and a press after an account switch
// sends nothing as the next account.
const host = vi.hoisted(() => ({
  userId: 'synthetic-owner', generation: 1,
  mutations: [] as Array<Record<string, any>>,
  rideSos: vi.fn(), sos: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (select?: (s: { user: { id: string }; sessionGeneration: number; isAuthenticated: boolean }) => unknown) => {
    const state = { user: { id: host.userId }, sessionGeneration: host.generation, isAuthenticated: true };
    return select ? select(state) : state;
  },
  requireAuthSessionForPrincipal: (owner: { userId: string; generation: number }) => {
    if (owner.userId !== host.userId || owner.generation !== host.generation) throw new Error('Account changed');
    return { ...owner, accessToken: `synthetic-token-${owner.userId}-${owner.generation}` };
  },
  requireAuthSessionSnapshot: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({}),
  useMutation: (options: Record<string, any>) => { host.mutations.push(options); return options; },
  useQueryClient: () => ({ invalidateQueries: host.invalidate }),
}));
vi.mock('react', () => ({ useRef: (current: unknown) => ({ current }) }));
vi.mock('../services/api', () => ({
  rideApi: { sos: host.rideSos },
  safetyApi: { sos: host.sos, confirmSos: host.confirm, cancelSos: host.cancel },
}));
vi.mock('./customer', () => ({ customerKeys: {} }));
vi.mock('../lib/rideRequestAttemptStore', () => ({ rideRequestAttempt: {} }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../lib/sosKey', () => ({ createSosKeyStore: () => ({ keyFor: () => 'synthetic-sos-key' }) }));

import { useRideSos } from './rides';
import { useCancelSos, useConfirmSos, useJobSos, useServiceJobSos } from './safety';

const ok = { data: { data: { id: 'synthetic-alert', status: 'TRIGGER_PENDING', graceEndsAt: null } } };
const session = expect.objectContaining({ userId: 'synthetic-owner', generation: 1, accessToken: 'synthetic-token-synthetic-owner-1' });
const cases = [
  { name: 'taxi SOS', hook: useRideSos, api: () => host.rideSos, arg: { id: 'synthetic-ride' }, at: 2, raise: true },
  { name: 'delivery SOS', hook: useJobSos, api: () => host.sos, arg: { jobId: 'synthetic-job' }, at: 1, raise: true },
  { name: 'service SOS', hook: useServiceJobSos, api: () => host.sos, arg: { serviceJobId: 'synthetic-service-job' }, at: 1, raise: true },
  { name: 'SOS confirm', hook: useConfirmSos, api: () => host.confirm, arg: 'synthetic-alert', at: 1, raise: false },
  { name: 'SOS cancel', hook: useCancelSos, api: () => host.cancel, arg: 'synthetic-alert', at: 1, raise: false },
] as const;

beforeEach(() => {
  vi.clearAllMocks(); host.userId = 'synthetic-owner'; host.generation = 1; host.mutations = [];
  for (const fn of [host.rideSos, host.sos, host.confirm, host.cancel]) fn.mockResolvedValue(ok);
});

describe('[73] every SOS call is bound to the account that pressed it', () => {
  it.each(cases)('$name carries that account\'s session', async ({ hook, api, arg, at }) => {
    (hook as () => unknown)();
    await host.mutations[0]!['mutationFn'](arg);
    expect(api()).toHaveBeenCalledOnce();
    expect(api().mock.calls[0]![at]).toEqual(session);
  });

  it.each(cases)('$name after an account switch sends nothing as the next account', async ({ hook, api, arg }) => {
    (hook as () => unknown)();
    host.generation = 2;
    await expect(host.mutations[0]!['mutationFn'](arg)).rejects.toThrow('Account changed');
    expect(api()).not.toHaveBeenCalled();
  });

  it.each(cases.filter((c) => c.raise))('$name refreshes the owner\'s alerts once raised', ({ hook }) => {
    (hook as () => unknown)();
    host.mutations[0]!['onSuccess']();
    expect(host.invalidate).toHaveBeenCalledWith({ queryKey: ['safety'] });
  });
});
