import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap"] A rider taps ~6 steps per delivery (on my way, arrived,
// picked up, on my way, arrived, delivered) and a driver ~4 per ride. Each step's button spun for the write AND the
// re-read of the active job (2 round trips, ~1.3 s on a mobile link), though the step's own answer already names the
// job's new status. Now that status is written into the active job at once (the single job and a stacked rider's
// legs) and the button is free at the answer; every mover read still refreshes, in the background. The steps that
// END or hand back a job still wait for the re-read (the completion flow follows the job leaving the active read).
// Driven through the REAL hooks' options against a REAL query client (the harness of mover.jobStepWait.test.ts).
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

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { useDriverAction, useRiderAction, writeJobStatus } from './mover';

type Step = { onSuccess?: (...args: unknown[]) => unknown };
const ACTIVE = (kind: string) => ['mover', 'active', kind];

/** The mover's reads as the job screen mounts them; `server` is what the active read answers (set it to the moved job). */
async function mount(kind: 'RIDER' | 'DRIVER', job: Record<string, unknown>, legs?: Array<Record<string, unknown>>) {
  const server = { job, gate: Promise.resolve() as Promise<void> };
  // What the server holds when the read LEAVES (a read that is slow to come back still carries that moment's job).
  const active = vi.fn(async () => { const answer = server.job; await server.gate; return answer; });
  const profile = vi.fn(async () => ({ id: 'mover-1' }));
  const observers = [
    new QueryObserver(fx.qc, { queryKey: ACTIVE(kind), queryFn: active }),
    new QueryObserver(fx.qc, { queryKey: ['mover', 'riderProfile'], queryFn: profile }),
    ...(legs ? [new QueryObserver(fx.qc, { queryKey: [...ACTIVE(kind), 'legs'], queryFn: async () => ({ legs, run: null }) })] : []),
  ];
  const unsubscribe = observers.map((o) => o.subscribe(() => {}));
  await vi.waitFor(() => expect(fx.qc.getQueryData(ACTIVE(kind))).toBeDefined());
  if (legs) await vi.waitFor(() => expect(fx.qc.getQueryData([...ACTIVE(kind), 'legs'])).toBeDefined());
  return { active, profile, server, stop: () => unsubscribe.forEach((u) => u()) };
}
const statusOf = (kind: string) => (fx.qc.getQueryData(ACTIVE(kind)) as { status?: string } | undefined)?.status;

beforeEach(() => { fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { fx.qc.clear(); });

describe('[TAP-AUDIT] a job step: the answered status at once, the button free at the answer', () => {
  it('a rider step: the next status is on screen at the answer; nothing to wait for; every read still refreshes', async () => {
    const reads = await mount('RIDER', { id: 'order-1', status: 'RIDER_EN_ROUTE_PICKUP' });
    const step = useRiderAction() as unknown as Step;
    const returned = step.onSuccess!({ orderId: 'order-1', status: 'RIDER_ARRIVED_PICKUP' }, { id: 'order-1', action: 'arrived-pickup' });
    expect(returned, 'the button is not held for the re-read').toBeUndefined();
    expect(statusOf('RIDER')).toBe('RIDER_ARRIVED_PICKUP');
    await vi.waitFor(() => expect(reads.active).toHaveBeenCalledTimes(2));
    expect(reads.profile).toHaveBeenCalledTimes(2);
    reads.stop();
  });

  it('a stacked rider: the leg with that order moves too, the other leg does not', async () => {
    const reads = await mount('RIDER', { id: 'order-1', status: 'PICKED_UP' }, [
      { id: 'order-1', status: 'PICKED_UP' }, { id: 'order-2', status: 'PICKED_UP' },
    ]);
    (useRiderAction() as unknown as Step).onSuccess!({ orderId: 'order-1', status: 'EN_ROUTE_DELIVERY' }, { id: 'order-1', action: 'en-route-delivery' });
    const legs = (fx.qc.getQueryData([...ACTIVE('RIDER'), 'legs']) as { legs: Array<{ id: string; status: string }> }).legs;
    expect(legs.map((l) => [l.id, l.status])).toEqual([['order-1', 'EN_ROUTE_DELIVERY'], ['order-2', 'PICKED_UP']]);
    reads.stop();
  });

  it('a driver step: the ride\'s new status (and the PIN check) at the answer', async () => {
    const reads = await mount('DRIVER', { id: 'ride-1', status: 'DRIVER_ARRIVED', ridePinVerified: false });
    const returned = (useDriverAction() as unknown as Step).onSuccess!({ id: 'ride-1', status: 'DRIVER_ARRIVED', ridePinVerified: true }, { id: 'ride-1', action: 'verify-pin' });
    expect(returned).toBeUndefined();
    expect(fx.qc.getQueryData(ACTIVE('DRIVER'))).toMatchObject({ status: 'DRIVER_ARRIVED', ridePinVerified: true });
    reads.stop();
  });

  it('a read already on its way is cancelled (it would land with the old status)', async () => {
    const reads = await mount('RIDER', { id: 'order-1', status: 'RIDER_ASSIGNED' });
    let release!: () => void;
    reads.server.gate = new Promise<void>((resolve) => { release = resolve; });
    void fx.qc.refetchQueries({ queryKey: ACTIVE('RIDER') }); // a poll leaves BEFORE the step, carrying RIDER_ASSIGNED
    reads.server.gate = Promise.resolve();
    reads.server.job = { id: 'order-1', status: 'RIDER_EN_ROUTE_PICKUP' }; // the step moves the job
    (useRiderAction() as unknown as Step).onSuccess!({ orderId: 'order-1', status: 'RIDER_EN_ROUTE_PICKUP' }, { id: 'order-1', action: 'en-route-pickup' });
    release(); // the poll that left before the step comes back late
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(statusOf('RIDER')).toBe('RIDER_EN_ROUTE_PICKUP');
    reads.stop();
  });

  const waits: Array<[string, () => Step, unknown, unknown]> = [
    ['the rider\'s delivered step (the job ends)', () => useRiderAction() as unknown as Step, { orderId: 'order-1', status: 'DELIVERED' }, { id: 'order-1', action: 'delivered' }],
    ['the door\'s handover (the job ends)', () => useRiderAction() as unknown as Step, { orderId: 'order-1', status: 'DELIVERED' }, { id: 'order-1', action: 'handover' }],
    ['the driver\'s fare outcome (the ride ends)', () => useDriverAction() as unknown as Step, { id: 'ride-1', status: 'COMPLETED' }, { id: 'ride-1', action: 'handover', outcome: 'paid' }],
    ['an answer with no status (an older server)', () => useRiderAction() as unknown as Step, {}, { id: 'order-1', action: 'picked-up' }],
    ['a job that is not the one on screen', () => useRiderAction() as unknown as Step, { orderId: 'order-9', status: 'PICKED_UP' }, { id: 'order-9', action: 'picked-up' }],
  ];
  for (const [name, hook, answer, input] of waits) {
    it(`${name}: still waits for the re-read`, async () => {
      const reads = await mount('RIDER', { id: 'order-1', status: 'ARRIVED' });
      const returned = hook().onSuccess!(answer, input);
      expect(returned).toBeInstanceOf(Promise);
      expect(statusOf('RIDER'), 'nothing written ahead of the re-read').toBe('ARRIVED');
      await returned;
      reads.stop();
    });
  }

  it('writeJobStatus: nothing to write without a job id or a status', () => {
    expect(writeJobStatus(fx.qc, undefined, { status: 'PICKED_UP' })).toBe(false);
    expect(writeJobStatus(fx.qc, 'order-1', { status: '' })).toBe(false);
    expect(writeJobStatus(fx.qc, 'order-1', null)).toBe(false);
  });
});
