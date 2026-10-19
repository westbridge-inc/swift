import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF partner #5] A rider reads the legs of a run only while on a job.
//
// A rider's Home and job screen read the active job (12 s) AND the legs of a
// stacked run (12 s). The server keeps the active pointer on a live leg, so an
// idle rider has no legs, yet both were read every 12 s: 5 extra reads a minute
// for every rider with the app open. Now the legs are read only while the
// active job is there, and an idle rider is never shown a finished run's legs.
// The active read keeps its poll (on the server it also heals a stale pointer).
//
// Driven through the REAL hook: useQuery hands back its options plus the data
// this test sets for that query.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ data: new Map<string, unknown>(), opts: new Map<string, any>() }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...real,
    useMutation: (options: unknown) => options,
    useQuery: (options: { queryKey: unknown[] }) => {
      const key = JSON.stringify(options.queryKey);
      fx.opts.set(key, options);
      return { ...options, data: fx.data.get(key), refetch: vi.fn() };
    },
    useQueryClient: () => ({}),
  };
});
vi.mock('../services/api', () => ({
  authApi: {}, customerApi: {}, driverApi: {}, riderApi: {}, rideApi: {},
}));
vi.mock('../stores/moverPreview', () => ({
  useMoverPreview: (selector: (state: { preview: boolean; kind: string }) => unknown) => selector({ preview: false, kind: 'DRIVER' }),
}));
vi.mock('../stores/locationStore', () => ({ useLocationStore: vi.fn() }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({}),
  getAuthSessionSnapshot: () => null,
  requireAuthSessionSnapshot: () => null,
  requireAuthSessionForPrincipal: () => null,
  AuthSessionBoundaryError: class extends Error {},
}));
vi.mock('../services/backgroundLocation', () => ({ startMoverLocation: vi.fn(), stopMoverLocation: vi.fn() }));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: vi.fn() }));
vi.mock('../services/devicePosition', () => ({ currentDevicePosition: vi.fn() }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../lib/deviceLocation', () => ({
  commitLiveDeviceLocation: vi.fn(),
  createLiveDeviceLocationLease: vi.fn(),
  isLiveDeviceLocationLeaseValid: vi.fn(),
}));
vi.mock('../lib/moverLocation', () => ({ sharedMoverLocationController: {} }));
vi.mock('../lib/moverPreviewData', () => ({ previewMutation: vi.fn(), previewQuery: vi.fn() }));
vi.mock('../lib/moverProfile', () => ({ resolveMoverProfile: vi.fn(), unwrapOptionalMoverProfile: vi.fn() }));
vi.mock('../lib/moverAuthorityCache', () => ({ canonicalMoverAuthority: vi.fn() }));
vi.mock('../services/notification-priming', () => ({ maybePrimeNotifications: vi.fn() }));
vi.mock('expo-location', () => ({ Accuracy: { Balanced: 3 }, getLastKnownPositionAsync: vi.fn(), getCurrentPositionAsync: vi.fn() }));

import { useActiveJobs } from './mover';
import { POLL } from '../lib/pollPolicy';

const ACTIVE = JSON.stringify(['mover', 'active', 'RIDER']);
const LEGS = JSON.stringify(['mover', 'active', 'RIDER', 'legs']);
const legA = { id: 'leg-a', status: 'PICKED_UP' };
const legB = { id: 'leg-b', status: 'RIDER_ASSIGNED' };
const run = { drops: 2, cashToCollect: 0, next: { orderId: 'leg-a', vendorName: 'Shop', status: 'PICKED_UP' } };

beforeEach(() => { fx.data.clear(); fx.opts.clear(); });

describe('[PERF partner #5] a rider reads the legs of a run only while on a job', () => {
  it('an idle rider: the active job is still polled, the legs are not read', () => {
    const r = useActiveJobs('RIDER');
    expect(fx.opts.get(ACTIVE).enabled).toBe(true);
    expect(fx.opts.get(ACTIVE).refetchInterval).toBe(POLL.moverActive);
    expect(fx.opts.get(LEGS).enabled).toBe(false);
    expect(r).toMatchObject({ legs: [], run: null });
  });

  it('a rider on a job: the legs are read at their pace and win', () => {
    fx.data.set(ACTIVE, legA);
    fx.data.set(LEGS, { legs: [legA, legB], run });
    const r = useActiveJobs('RIDER');
    expect(fx.opts.get(LEGS).enabled).toBe(true);
    expect(fx.opts.get(LEGS).refetchInterval).toBe(POLL.moverLegs);
    expect(r.legs).toEqual([legA, legB]);
    expect(r.run).toEqual(run);
  });

  it('a rider whose job just ended is not shown the finished run\'s legs', () => {
    fx.data.set(ACTIVE, null);
    fx.data.set(LEGS, { legs: [legA, legB], run });
    const r = useActiveJobs('RIDER');
    expect(fx.opts.get(LEGS).enabled).toBe(false);
    expect(r).toMatchObject({ legs: [], run: null });
  });

  it('a driver never reads legs (one ride at a time), as before', () => {
    fx.data.set(JSON.stringify(['mover', 'active', 'DRIVER']), { id: 'ride-1' });
    const r = useActiveJobs('DRIVER');
    expect(fx.opts.get(JSON.stringify(['mover', 'active', 'DRIVER', 'legs'])).enabled).toBe(false);
    expect(r.legs).toEqual([{ id: 'ride-1' }]);
  });
});
