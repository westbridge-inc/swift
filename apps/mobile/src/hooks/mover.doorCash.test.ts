import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

// ---------------------------------------------------------------------------
// [L02 · row 56] The rider's door statement reaches POST /rider/orders/:id/
// handover exactly as the screen built it: the stated cash, whether partial
// cash was handed back, a short hand-over, and the door's version. A field the
// screen leaves out is never sent (builds 9-11 send none of them, and the
// server reads that as the older, unstated door).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  BoundaryError: class TestAuthSessionBoundaryError extends Error {},
  current: null as AuthSessionSnapshot | null,
  riderHandover: vi.fn(),
  lastKnownPosition: vi.fn(),
  currentPosition: vi.fn(),
}));

const accountA: AuthSessionSnapshot = { generation: 1, userId: 'account-a', accessToken: 'access-a-1', refreshToken: 'refresh-a-1' };

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQuery: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../stores/authStore', () => {
  const useAuthStore = Object.assign((selector: (state: any) => unknown) => selector({ user: null }), { getState: () => ({ user: null }) });
  return {
    AuthSessionBoundaryError: mocks.BoundaryError,
    getAuthSessionSnapshot: () => mocks.current,
    requireAuthSessionSnapshot: () => {
      if (!mocks.current) throw new mocks.BoundaryError();
      return { ...mocks.current };
    },
    requireAuthSessionForPrincipal: (owner: AuthSessionSnapshot) => {
      if (!mocks.current || mocks.current.generation !== owner.generation || mocks.current.userId !== owner.userId) throw new mocks.BoundaryError();
      return { ...mocks.current };
    },
    useAuthStore,
  };
});
vi.mock('../services/api', () => ({
  authApi: { pricing: vi.fn() },
  customerApi: {},
  driverApi: {},
  riderApi: { handover: mocks.riderHandover },
  rideApi: {},
}));
vi.mock('../stores/moverPreview', () => ({
  useMoverPreview: (selector: (state: { preview: boolean; kind: string }) => unknown) => selector({ preview: false, kind: 'RIDER' }),
}));
vi.mock('../stores/locationStore', () => ({ useLocationStore: vi.fn() }));
vi.mock('../services/backgroundLocation', () => ({ startMoverLocation: vi.fn(), stopMoverLocation: vi.fn() }));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: vi.fn() }));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../lib/deviceLocation', () => ({
  commitLiveDeviceLocation: vi.fn(),
  createLiveDeviceLocationLease: vi.fn(),
  isLiveDeviceLocationLeaseValid: vi.fn(),
}));
vi.mock('../lib/moverLocation', () => ({ sharedMoverLocationController: {} }));
vi.mock('../lib/moverPreviewData', () => ({ PREVIEW_VERIFICATION: {}, previewMutation: vi.fn(), previewQuery: vi.fn() }));
vi.mock('../lib/moverProfile', () => ({ resolveMoverProfile: vi.fn(), unwrapOptionalMoverProfile: vi.fn() }));
vi.mock('../lib/moverAuthorityCache', () => ({ canonicalMoverAuthority: (_r: unknown, role: string) => ({ activeRole: role, lastMoverRole: role }) }));
vi.mock('../services/notification-priming', () => ({ maybePrimeNotifications: vi.fn() }));
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getLastKnownPositionAsync: mocks.lastKnownPosition,
  getCurrentPositionAsync: mocks.currentPosition,
}));

import { useRiderAction } from './mover';

type Captured = { mutationFn: (v: Record<string, unknown>) => Promise<unknown> };
let mutation: Captured;
const run = (vars: Record<string, unknown>) => mutation.mutationFn(vars);
const sentBody = () => mocks.riderHandover.mock.calls[0]![1];
const GPS = { lat: 6.81, lng: -58.15 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.current = { ...accountA };
  mocks.lastKnownPosition.mockResolvedValue({ coords: { latitude: GPS.lat, longitude: GPS.lng } });
  mocks.riderHandover.mockResolvedValue({ data: { success: true, data: { orderId: 'o1', status: 'DELIVERED' } } });
  mutation = useRiderAction() as unknown as Captured; // react-query is a pass-through here: the options object
});

describe('the door statement reaches the handover route', () => {
  it('paid in full: the amount, the code and the door version', async () => {
    await run({ id: 'o1', action: 'handover', outcome: 'paid', collectedAmount: 2500, pin: '123456', handoverVersion: 'door-v1' });
    expect(mocks.riderHandover).toHaveBeenCalledWith('o1', { outcome: 'paid', gps: GPS, ridePin: '123456', collectedAmount: 2500, handoverVersion: 'door-v1' }, accountA);
  });

  it("can't pay in full: short_payment with the partial cash and whether it was handed back", async () => {
    await run({ id: 'o1', action: 'handover', outcome: 'short_payment', collectedAmount: 1000, cashReturned: false, handoverVersion: 'door-v1' });
    expect(sentBody()).toEqual({ outcome: 'short_payment', gps: GPS, collectedAmount: 1000, cashReturned: false, handoverVersion: 'door-v1' });
  });

  it('nothing taken: collectedAmount 0 is sent (a statement), with no cashReturned', async () => {
    await run({ id: 'o1', action: 'handover', outcome: 'short_payment', collectedAmount: 0 });
    expect(sentBody()).toEqual({ outcome: 'short_payment', gps: GPS, collectedAmount: 0 });
  });

  it('already handed over short: handedOverShort true rides the paid outcome', async () => {
    await run({ id: 'o1', action: 'handover', outcome: 'paid', collectedAmount: 1000, handedOverShort: true, pin: '123456' });
    expect(sentBody()).toEqual({ outcome: 'paid', gps: GPS, ridePin: '123456', collectedAmount: 1000, handedOverShort: true });
  });

  it('the failed outcomes stay exactly as they were: no cash fields at all', async () => {
    await run({ id: 'o1', action: 'handover', outcome: 'refused' });
    expect(sentBody()).toEqual({ outcome: 'refused', gps: GPS });
  });

  it('the server’s answer is handed back to the screen untouched', async () => {
    const answer = { orderId: 'o1', status: 'DELIVERED', claim: null, cash: { due: 2500, collected: 1000, shortfall: 1500, heldForReview: true } };
    mocks.riderHandover.mockResolvedValue({ data: { success: true, data: answer } });
    await expect(run({ id: 'o1', action: 'handover', outcome: 'paid', collectedAmount: 1000, handedOverShort: true })).resolves.toEqual(answer);
  });
});
