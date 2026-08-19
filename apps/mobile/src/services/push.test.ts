import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

const mocks = vi.hoisted(() => ({
  current: null as AuthSessionSnapshot | null,
  post: vi.fn(),
  getPermissions: vi.fn(async () => ({ status: 'granted' })),
  requestPermissions: vi.fn(async () => ({ status: 'granted' })),
  getPushToken: vi.fn(async () => ({ data: 'ExponentPushToken[shared-device]' })),
  setChannel: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  setNotificationHandler: vi.fn(),
  setNotificationChannelAsync: mocks.setChannel,
  getPermissionsAsync: mocks.getPermissions,
  requestPermissionsAsync: mocks.requestPermissions,
  getExpoPushTokenAsync: mocks.getPushToken,
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
vi.mock('axios', () => ({
  default: {
    post: mocks.post,
    isAxiosError: (error: { isAxiosError?: boolean }) => error?.isAxiosError === true,
  },
}));
vi.mock('./api', () => ({ API_URL: 'https://api.test' }));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => mocks.current,
}));

const sessionA: AuthSessionSnapshot = {
  generation: 1,
  userId: 'a',
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
};

const sessionB: AuthSessionSnapshot = {
  generation: 3,
  userId: 'b',
  accessToken: 'access-b',
  refreshToken: 'refresh-b',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.current = { ...sessionA };
  mocks.getPermissions.mockResolvedValue({ status: 'granted' });
  mocks.getPushToken.mockResolvedValue({ data: 'ExponentPushToken[shared-device]' });
});

describe('push registration ownership', () => {
  it('lets A logout await A registration, then still registers B with B credentials', async () => {
    const pendingA = deferred<unknown>();
    mocks.post.mockReturnValueOnce(pendingA.promise).mockResolvedValueOnce({ data: { success: true } });
    const push = await import('./push');

    const registeringA = push.registerIfGranted();
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    mocks.current = { ...sessionB };
    const aLogoutToken = push.preparePushTokenForLogout(sessionA);

    pendingA.resolve({ data: { success: true } });
    await registeringA;
    await expect(aLogoutToken).resolves.toBe('ExponentPushToken[shared-device]');

    await push.registerIfGranted();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0]?.[2]?.headers?.Authorization).toBe('Bearer access-a');
    expect(mocks.post.mock.calls[1]?.[2]?.headers?.Authorization).toBe('Bearer access-b');
  });

  it('does not let a failed A registration suppress B registration', async () => {
    mocks.post
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: { success: true } });
    const push = await import('./push');

    await expect(push.registerIfGranted()).resolves.toBeUndefined();
    mocks.current = { ...sessionB };
    await expect(push.registerIfGranted()).resolves.toBeUndefined();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]?.[2]?.headers?.Authorization).toBe('Bearer access-b');
  });
});
