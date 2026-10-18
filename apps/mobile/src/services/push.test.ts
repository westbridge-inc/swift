import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

const mocks = vi.hoisted(() => ({
  current: null as AuthSessionSnapshot | null,
  post: vi.fn(),
  getPermissions: vi.fn(async () => ({ status: 'granted' })),
  requestPermissions: vi.fn(async () => ({ status: 'granted' })),
  getPushToken: vi.fn(async () => ({ data: 'ExponentPushToken[shared-device]' })),
  setChannel: vi.fn(async () => undefined),
  platform: { OS: 'ios' as 'ios' | 'android' },
  hasJobRing: vi.fn(() => false),
  openSettings: vi.fn(async () => undefined),
  appStateListeners: [] as Array<(state: string) => void>,
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  Linking: { openSettings: mocks.openSettings },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.push(listener);
      return { remove: () => { mocks.appStateListeners = mocks.appStateListeners.filter((l) => l !== listener); } };
    },
  },
}));
// [RINGER] Whether this binary has the job ring (build 12) is a native fact.
vi.mock('./jobRingCapability', () => ({
  JOB_OFFERS_CHANNEL: 'job_offers',
  JOB_RING_SOUND: 'swift_job_ring.wav',
  hasJobRing: mocks.hasJobRing,
  jobAlertsVersion: () => (mocks.hasJobRing() ? 1 : 0),
}));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, MAX: 5 },
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
  mocks.platform.OS = 'ios';
  mocks.hasJobRing.mockReturnValue(false);
  mocks.getPermissions.mockResolvedValue({ status: 'granted' });
  mocks.getPushToken.mockResolvedValue({ data: 'ExponentPushToken[shared-device]' });
  mocks.appStateListeners = [];
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

describe('[RINGER] job alerts: the channel and what the server is told', () => {
  it('build 12 on Android: creates the Job offers channel with the tone, at MAX, leaving Do Not Disturb to the partner', async () => {
    mocks.platform.OS = 'android';
    mocks.hasJobRing.mockReturnValue(true);
    mocks.post.mockResolvedValue({ data: { success: true } });
    const push = await import('./push');
    await push.registerIfGranted();

    const channels = mocks.setChannel.mock.calls.map((call) => (call as unknown as [string, Record<string, unknown>]));
    expect(channels.map(([id]) => id)).toEqual(['default', 'job_offers']);
    expect(channels[1]![1]).toMatchObject({
      name: 'Job offers',
      importance: 5,
      sound: 'swift_job_ring.wav',
      enableVibrate: true,
      bypassDnd: false,
    });
    expect(mocks.post.mock.calls[0]?.[1]).toEqual({ token: 'ExponentPushToken[shared-device]', platform: 'android', alertsVersion: 1 });
  });

  it('builds 9-11 on Android (this JS over the air): never creates the channel soundless, reports alertsVersion 0', async () => {
    mocks.platform.OS = 'android';
    mocks.post.mockResolvedValue({ data: { success: true } });
    const push = await import('./push');
    await push.registerIfGranted();

    expect(mocks.setChannel.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(['default']);
    expect(mocks.post.mock.calls[0]?.[1]).toEqual({ token: 'ExponentPushToken[shared-device]', platform: 'android', alertsVersion: 0 });
  });

  it('iOS reports the same native fact', async () => {
    mocks.hasJobRing.mockReturnValue(true);
    mocks.post.mockResolvedValue({ data: { success: true } });
    const push = await import('./push');
    await push.registerIfGranted();
    expect(mocks.setChannel).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls[0]?.[1]).toEqual({ token: 'ExponentPushToken[shared-device]', platform: 'ios', alertsVersion: 1 });
  });
});

// [STORE-ALERT 18 Oct 2026] A store iPhone was never asked for notifications:
// iOS starts undetermined, the session start only registers when permission
// is ALREADY granted, and nothing in the store app could ask or open Settings.
describe('[STORE-ALERT] an earner can turn push on, and coming back from Settings registers', () => {
  it('reads what turning push on takes: nothing, the OS prompt, or Settings', async () => {
    const push = await import('./push');
    mocks.getPermissions.mockResolvedValueOnce({ status: 'granted', canAskAgain: true } as never);
    await expect(push.pushPermission()).resolves.toBe('granted');
    mocks.getPermissions.mockResolvedValueOnce({ status: 'undetermined', canAskAgain: true } as never);
    await expect(push.pushPermission()).resolves.toBe('ask');
    mocks.getPermissions.mockResolvedValueOnce({ status: 'denied', canAskAgain: false } as never);
    await expect(push.pushPermission()).resolves.toBe('settings');
    // Android 13+ may ask again after one refusal.
    mocks.getPermissions.mockResolvedValueOnce({ status: 'denied', canAskAgain: true } as never);
    await expect(push.pushPermission()).resolves.toBe('ask');
  });

  it('"Turn on" while the OS can still ask shows the prompt and registers on a yes', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    mocks.getPermissions
      .mockResolvedValueOnce({ status: 'undetermined', canAskAgain: true } as never) // turnOnPush reads
      .mockResolvedValueOnce({ status: 'undetermined', canAskAgain: true } as never) // register reads
      .mockResolvedValue({ status: 'granted', canAskAgain: true } as never);
    const push = await import('./push');
    await expect(push.turnOnPush()).resolves.toBe('granted');
    expect(mocks.requestPermissions).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      'https://api.test/api/v1/customer/notifications/devices',
      // [RINGER] registration also says what the binary can ring with (0 = no job ring)
      { token: 'ExponentPushToken[shared-device]', platform: 'ios', alertsVersion: 0 },
      expect.anything(),
    );
    expect(mocks.openSettings).not.toHaveBeenCalled();
  });

  it('"Turn on" after iOS was refused opens Settings (the prompt cannot show again)', async () => {
    mocks.getPermissions.mockResolvedValue({ status: 'denied', canAskAgain: false } as never);
    const push = await import('./push');
    await expect(push.turnOnPush()).resolves.toBe('settings');
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('returning to the foreground registers a phone that was turned on in Settings meanwhile', async () => {
    mocks.post.mockResolvedValue({ data: { success: true } });
    mocks.getPermissions.mockResolvedValueOnce({ status: 'denied', canAskAgain: false } as never);
    const push = await import('./push');
    await push.registerIfGranted();
    expect(mocks.post).not.toHaveBeenCalled();

    const uninstall = push.installPushForegroundRetry();
    mocks.getPermissions.mockResolvedValue({ status: 'granted', canAskAgain: true } as never);
    for (const listener of mocks.appStateListeners) listener('background');
    expect(mocks.post).not.toHaveBeenCalled();
    for (const listener of mocks.appStateListeners) listener('active');
    await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    uninstall();
    expect(mocks.appStateListeners).toHaveLength(0);
  });
});
