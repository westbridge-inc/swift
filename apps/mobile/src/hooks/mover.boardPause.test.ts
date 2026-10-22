import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF partner #4] A taxi driver's job board rests during a ride.
//
// By law a taxi driver carries one ride at a time, yet the board polled every
// 10 s (30 s on a slow network) while they were online, through the whole ride:
// six wasted reads a minute per driver. It now rests while a DRIVER is on a
// ride and reads again when the ride ends. A rider's board keeps polling during
// a job: stacking lets a rider carry 1 to 3 jobs.
//
// Driven through the REAL hook's query options.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...real,
    useMutation: (options: unknown) => options,
    useQuery: (options: unknown) => options,
    useQueryClient: () => fx.qc,
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

import { useAvailableJobs } from './mover';
import { BOARD_MAX_AGE_MS, boardPaused, recentBoard } from '../lib/moverBoard';
import { POLL } from '../lib/pollPolicy';

type BoardQuery = { enabled: boolean; refetchInterval: () => number | false; queryKey: unknown[] };
const useBoard = (...args: Parameters<typeof useAvailableJobs>) => useAvailableJobs(...args) as unknown as BoardQuery;

describe('[PERF partner #4] the job board', () => {
  it('a taxi driver on a ride: not read, not polled', () => {
    const q = useBoard('DRIVER', true, true);
    expect(q.enabled).toBe(false);
    expect(q.refetchInterval()).toBe(false);
  });

  it('a taxi driver between rides: read and polled at the board pace', () => {
    const q = useBoard('DRIVER', true, false);
    expect(q.enabled).toBe(true);
    expect(q.refetchInterval()).toBe(POLL.moverAvailable());
    expect(q.refetchInterval()).not.toBe(false);
  });

  it('a rider on a job keeps polling (stacking: 1 to 3 jobs)', () => {
    const q = useBoard('RIDER', true, true);
    expect(q.enabled).toBe(true);
    expect(q.refetchInterval()).toBe(POLL.moverAvailable());
  });

  it('offline: nobody polls, as before', () => {
    const driver = useBoard('DRIVER', false, false);
    const rider = useBoard('RIDER', false, false);
    expect([driver.enabled, rider.enabled]).toEqual([false, false]);
    expect([driver.refetchInterval(), rider.refetchInterval()]).toEqual([false, false]);
  });

  it('the same board query either way, so the read resumes into the same cache when the ride ends', () => {
    expect(useBoard('DRIVER', true, true).queryKey).toEqual(useBoard('DRIVER', true, false).queryKey);
  });

  it('after a rest, an answer older than three slow-network board polls is not drawn (#1919 review S4-1)', () => {
    const now = 1_000_000_000;
    expect(BOARD_MAX_AGE_MS).toBe(3 * 30_000);
    expect(recentBoard([1], now - 89_000, now)).toEqual([1]);
    expect(recentBoard([1], now - 91_000, now)).toEqual([]);
    expect(recentBoard([1], undefined, now)).toEqual([1]);
    expect(recentBoard(undefined, now, now)).toEqual([]);
  });

  it('the rule itself', () => {
    expect(boardPaused('DRIVER', true)).toBe(true);
    expect(boardPaused('DRIVER', false)).toBe(false);
    expect(boardPaused('RIDER', true)).toBe(false);
    expect(boardPaused(null, true)).toBe(false);
  });
});
