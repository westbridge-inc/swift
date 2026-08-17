import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

const mocks = vi.hoisted(() => ({
  BoundaryError: class TestAuthSessionBoundaryError extends Error {},
  current: null as AuthSessionSnapshot | null,
  user: null as any,
  invalidateQueries: vi.fn(),
  setUserIfCurrent: vi.fn(),
  switchRole: vi.fn(),
  driverGoOnline: vi.fn(),
  driverUploadVehicle: vi.fn(),
  riderHandover: vi.fn(),
  lastKnownPosition: vi.fn(),
  currentPosition: vi.fn(),
  uploadVerification: vi.fn(),
  submitDocument: vi.fn(),
  submitIdentity: vi.fn(),
  becomePartner: vi.fn(),
  uploadCourierProof: vi.fn(),
  confirmCourierProof: vi.fn(),
  primeNotifications: vi.fn(),
  track: vi.fn(),
}));

const accountA: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-a',
  accessToken: 'access-a-1',
  refreshToken: 'refresh-a-1',
};

const accountB: AuthSessionSnapshot = {
  generation: 3,
  userId: 'account-b',
  accessToken: 'access-b-1',
  refreshToken: 'refresh-b-1',
};

function samePrincipal(left: AuthSessionSnapshot | null, right: AuthSessionSnapshot): boolean {
  return !!left
    && left.generation === right.generation
    && left.userId === right.userId;
}

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => options,
  useQuery: (options: unknown) => options,
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('../stores/authStore', () => {
  const useAuthStore = Object.assign(
    (selector: (state: any) => unknown) => selector({
      user: mocks.user,
      setUserIfCurrent: mocks.setUserIfCurrent,
    }),
    { getState: () => ({ user: mocks.user, setUserIfCurrent: mocks.setUserIfCurrent }) },
  );
  return {
    AuthSessionBoundaryError: mocks.BoundaryError,
    getAuthSessionSnapshot: () => mocks.current,
    requireAuthSessionSnapshot: () => {
      if (!mocks.current) throw new mocks.BoundaryError();
      return { ...mocks.current };
    },
    requireAuthSessionForPrincipal: (owner: AuthSessionSnapshot) => {
      if (
        !mocks.current
        || mocks.current.generation !== owner.generation
        || mocks.current.userId !== owner.userId
      ) throw new mocks.BoundaryError();
      return { ...mocks.current };
    },
    useAuthStore,
  };
});

vi.mock('../services/api', () => ({
  authApi: { pricing: vi.fn() },
  customerApi: { switchRole: mocks.switchRole },
  driverApi: {
    goOnline: mocks.driverGoOnline,
    uploadVehiclePhoto: mocks.driverUploadVehicle,
  },
  riderApi: { handover: mocks.riderHandover },
  verificationApi: {
    upload: mocks.uploadVerification,
    submitDocument: mocks.submitDocument,
    submitIdentity: mocks.submitIdentity,
  },
  partnerApi: { become: mocks.becomePartner },
  courierApi: {
    uploadProof: mocks.uploadCourierProof,
    proof: mocks.confirmCourierProof,
  },
}));

vi.mock('../stores/moverPreview', () => ({
  useMoverPreview: (selector: (state: { preview: boolean; kind: string }) => unknown) =>
    selector({ preview: false, kind: 'DRIVER' }),
}));
vi.mock('../stores/locationStore', () => ({ useLocationStore: vi.fn() }));
vi.mock('../services/backgroundLocation', () => ({
  startMoverLocation: vi.fn(),
  stopMoverLocation: vi.fn(),
}));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: vi.fn() }));
vi.mock('../lib/analytics', () => ({ track: mocks.track }));
vi.mock('../lib/deviceLocation', () => ({
  commitLiveDeviceLocation: vi.fn(),
  createLiveDeviceLocationLease: vi.fn(),
  isLiveDeviceLocationLeaseValid: vi.fn(),
}));
vi.mock('../lib/moverLocation', () => ({ sharedMoverLocationController: {} }));
vi.mock('../lib/moverPreviewData', () => ({
  PREVIEW_VERIFICATION: {},
  previewMutation: vi.fn(),
  previewQuery: vi.fn(),
}));
vi.mock('../lib/moverProfile', () => ({
  resolveMoverProfile: vi.fn(),
  unwrapOptionalMoverProfile: vi.fn(),
}));
vi.mock('../lib/moverAuthorityCache', () => ({
  canonicalMoverAuthority: (_result: unknown, role: string) => ({
    activeRole: role,
    lastMoverRole: role,
  }),
}));
vi.mock('../services/notification-priming', () => ({
  maybePrimeNotifications: mocks.primeNotifications,
}));
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getLastKnownPositionAsync: mocks.lastKnownPosition,
  getCurrentPositionAsync: mocks.currentPosition,
}));

import {
  useGoOnline,
  useRiderAction,
  useSelectMoverKind,
  useUploadVehiclePhoto,
} from './mover';
import { useBecomePartner, useUploadDocument } from './verification';
import { useCourierProof } from './courier';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CapturedMutation<TVariables, TResult = unknown> = {
  mutationFn: (variables: TVariables) => Promise<TResult>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('FormData', class {
    append() {}
  });
  mocks.current = { ...accountA };
  mocks.user = {
    id: accountA.userId,
    firstName: 'Account',
    lastName: 'A',
    roles: ['MOVER'],
    lastMoverRole: 'RIDER',
  };
  mocks.setUserIfCurrent.mockImplementation((owner: AuthSessionSnapshot, user: any) => {
    if (!samePrincipal(mocks.current, owner) || user.id !== owner.userId) return false;
    mocks.user = user;
    return true;
  });
  mocks.invalidateQueries.mockResolvedValue(undefined);
});

describe('multi-step authenticated mutation ownership', () => {
  it('blocks go-online before the second API call when B logs in during A role switch', async () => {
    const roleSwitch = deferred<any>();
    mocks.switchRole.mockReturnValue(roleSwitch.promise);
    const mutation = useGoOnline('DRIVER') as unknown as CapturedMutation<{
      latitude: number;
      longitude: number;
    }>;

    const result = mutation.mutationFn({ latitude: 6.8, longitude: -58.1 });
    expect(mocks.switchRole).toHaveBeenCalledWith('DRIVER', accountA);
    mocks.current = { ...accountB };
    mocks.user = { id: accountB.userId, firstName: 'Account', lastName: 'B' };
    roleSwitch.resolve({ data: { data: { activeRole: 'DRIVER' } } });

    await expect(result).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.driverGoOnline).not.toHaveBeenCalled();
    expect(mocks.user.id).toBe(accountB.userId);
  });

  it('uses A rotated credentials for go-online when the principal did not change', async () => {
    const roleSwitch = deferred<any>();
    mocks.switchRole.mockReturnValue(roleSwitch.promise);
    mocks.driverGoOnline.mockResolvedValue({ data: { data: { online: true } } });
    const mutation = useGoOnline('DRIVER') as unknown as CapturedMutation<{
      latitude: number;
      longitude: number;
    }>;

    const result = mutation.mutationFn({ latitude: 6.8, longitude: -58.1 });
    mocks.current = {
      ...accountA,
      accessToken: 'access-a-2',
      refreshToken: 'refresh-a-2',
    };
    roleSwitch.resolve({ data: { data: { activeRole: 'DRIVER' } } });

    await expect(result).resolves.toEqual({ online: true });
    expect(mocks.driverGoOnline).toHaveBeenCalledWith(
      6.8,
      -58.1,
      expect.objectContaining({ userId: accountA.userId, accessToken: 'access-a-2' }),
    );
  });

  it('rejects a delayed A GO callback before role-switching as B', async () => {
    const mutation = useGoOnline('DRIVER') as unknown as CapturedMutation<{
      latitude: number;
      longitude: number;
      authSession: AuthSessionSnapshot;
    }>;
    mocks.current = { ...accountB };
    mocks.user = { id: accountB.userId, firstName: 'Account', lastName: 'B' };

    await expect(mutation.mutationFn({
      latitude: 6.8,
      longitude: -58.1,
      authSession: accountA,
    })).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.switchRole).not.toHaveBeenCalled();
    expect(mocks.driverGoOnline).not.toHaveBeenCalled();
  });

  it('rejects an A vehicle-photo picker result before uploading as B', async () => {
    const mutation = useUploadVehiclePhoto('DRIVER') as unknown as CapturedMutation<{
      uri: string;
      name: string;
      type: string;
      authSession: AuthSessionSnapshot;
    }>;
    mocks.current = { ...accountB };
    mocks.user = { id: accountB.userId, firstName: 'Account', lastName: 'B' };

    await expect(mutation.mutationFn({
      uri: 'file://account-a-vehicle.jpg',
      name: 'vehicle.jpg',
      type: 'image/jpeg',
      authSession: accountA,
    })).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.driverUploadVehicle).not.toHaveBeenCalled();
  });

  it('cannot let a late A mover selection overwrite B user state', async () => {
    const roleSwitch = deferred<any>();
    mocks.switchRole.mockReturnValue(roleSwitch.promise);
    const mutation = useSelectMoverKind() as unknown as CapturedMutation<'DRIVER'>;

    const result = mutation.mutationFn('DRIVER');
    mocks.current = { ...accountB };
    mocks.user = { id: accountB.userId, firstName: 'Account', lastName: 'B' };
    roleSwitch.resolve({ data: { data: { activeRole: 'DRIVER' } } });

    await expect(result).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.setUserIfCurrent).not.toHaveBeenCalled();
    expect(mocks.user.id).toBe(accountB.userId);
  });

  it('does not submit A verification upload as B', async () => {
    const upload = deferred<any>();
    mocks.uploadVerification.mockReturnValue(upload.promise);
    const mutation = useUploadDocument('MOVER') as unknown as CapturedMutation<{
      docType: string;
      file: { uri: string; name: string; type: string };
    }>;

    const result = mutation.mutationFn({
      docType: 'GOVERNMENT_ID',
      file: { uri: 'file://id.jpg', name: 'id.jpg', type: 'image/jpeg' },
    });
    expect(mocks.uploadVerification).toHaveBeenCalledWith(expect.anything(), accountA);
    mocks.current = { ...accountB };
    upload.resolve({ data: { data: { url: '/private/a-id.jpg' } } });

    await expect(result).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.submitDocument).not.toHaveBeenCalled();
  });

  it('rejects a delayed A document picker before uploading as B', async () => {
    const mutation = useUploadDocument('MOVER') as unknown as CapturedMutation<{
      docType: string;
      file: { uri: string; name: string; type: string };
      authSession: AuthSessionSnapshot;
    }>;
    mocks.current = { ...accountB };

    await expect(mutation.mutationFn({
      docType: 'GOVERNMENT_ID',
      file: { uri: 'file://account-a-id.jpg', name: 'id.jpg', type: 'image/jpeg' },
      authSession: accountA,
    })).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.uploadVerification).not.toHaveBeenCalled();
    expect(mocks.submitDocument).not.toHaveBeenCalled();
  });

  it('does not hand A rider work over as B after native location awaits', async () => {
    const location = deferred<any>();
    mocks.lastKnownPosition.mockReturnValue(location.promise);
    const mutation = useRiderAction() as unknown as CapturedMutation<{
      id: string;
      action: 'handover';
    }>;

    const result = mutation.mutationFn({ id: 'order-a', action: 'handover' });
    mocks.current = { ...accountB };
    location.resolve({ coords: { latitude: 6.8, longitude: -58.1 } });

    await expect(result).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.riderHandover).not.toHaveBeenCalled();
  });

  it('does not confirm A courier proof as B', async () => {
    const upload = deferred<any>();
    mocks.uploadCourierProof.mockReturnValue(upload.promise);
    const mutation = useCourierProof() as unknown as CapturedMutation<{
      orderId: string;
      uri: string;
    }>;

    const result = mutation.mutationFn({ orderId: 'order-a', uri: 'file://proof.jpg' });
    expect(mocks.uploadCourierProof).toHaveBeenCalledWith('order-a', expect.anything(), accountA);
    mocks.current = { ...accountB };
    upload.resolve({ data: { data: { url: '/private/a-proof.jpg' } } });

    await expect(result).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.confirmCourierProof).not.toHaveBeenCalled();
  });

  it('rejects a delayed A proof-camera result before uploading as B', async () => {
    const mutation = useCourierProof() as unknown as CapturedMutation<{
      orderId: string;
      uri: string;
      authSession: AuthSessionSnapshot;
    }>;
    mocks.current = { ...accountB };

    await expect(mutation.mutationFn({
      orderId: 'order-a',
      uri: 'file://account-a-proof.jpg',
      authSession: accountA,
    })).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.uploadCourierProof).not.toHaveBeenCalled();
    expect(mocks.confirmCourierProof).not.toHaveBeenCalled();
  });

  it('cannot apply a late A partner result to B', async () => {
    const become = deferred<any>();
    mocks.becomePartner.mockReturnValue(become.promise);
    const mutation = useBecomePartner() as unknown as CapturedMutation<{ role: 'MOVER' }>;

    const result = mutation.mutationFn({ role: 'MOVER' });
    expect(mocks.becomePartner).toHaveBeenCalledWith({ role: 'MOVER' }, accountA);
    mocks.current = { ...accountB };
    mocks.user = { id: accountB.userId, firstName: 'Account', lastName: 'B' };
    become.resolve({ data: { data: { roles: ['MOVER'], activeRole: 'DRIVER' } } });

    await expect(result).rejects.toBeInstanceOf(mocks.BoundaryError);
    expect(mocks.setUserIfCurrent).not.toHaveBeenCalled();
    expect(mocks.primeNotifications).not.toHaveBeenCalled();
    expect(mocks.user.id).toBe(accountB.userId);
  });
});
