import { beforeEach, describe, expect, it, vi } from 'vitest';

// [INAPP-CALLS] The SDK is reached only through a guard: a build without the native module (11/12, which
// over-the-air JS reaches) never imports it, so it can never crash at start (memory: native-module trap).
const rn = vi.hoisted(() => ({ native: {} as Record<string, unknown>, os: 'ios' as 'ios' | 'android', granted: true, requestResult: 'granted' }));
const sdkState = vi.hoisted(() => ({ imported: 0, connectFails: false, calls: [] as Array<{ m: string; a: unknown[] }> }));

vi.mock('react-native', () => ({
  NativeModules: new Proxy({}, { get: (_t, k: string) => rn.native[k] }),
  Platform: { get OS() { return rn.os; } },
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
    RESULTS: { GRANTED: 'granted' },
    check: vi.fn(async () => rn.granted),
    request: vi.fn(async () => rn.requestResult),
  },
}));

vi.mock('@twilio/voice-react-native-sdk', () => {
  sdkState.imported += 1;
  class Voice {
    initializePushRegistry = vi.fn(async () => { sdkState.calls.push({ m: 'initializePushRegistry', a: [] }); });
    setIncomingCallContactHandleTemplate = vi.fn(async (t?: string) => { sdkState.calls.push({ m: 'template', a: [t] }); });
    register = vi.fn(async (t: string) => { sdkState.calls.push({ m: 'register', a: [t] }); });
    unregister = vi.fn(async (t: string) => { sdkState.calls.push({ m: 'unregister', a: [t] }); });
    connect = vi.fn(async (t: string, o: unknown) => {
      sdkState.calls.push({ m: 'connect', a: [t, o] });
      if (sdkState.connectFails) throw new Error('connect failed');
      return { disconnect: vi.fn(async () => undefined), on: vi.fn() };
    });
  }
  return { Voice };
});

import * as voice from './inAppVoice';

beforeEach(() => {
  voice.resetInAppVoiceForTests();
  rn.native = {}; rn.os = 'ios'; rn.granted = true; rn.requestResult = 'granted';
  sdkState.imported = 0; sdkState.connectFails = false; sdkState.calls = [];
});

describe('[INAPP-CALLS] a build without the calling module (11/12)', () => {
  it('never imports the SDK, reports unavailable, and every call is a quiet no-op', async () => {
    expect(voice.inAppVoiceAvailable()).toBe(false);
    await voice.startInAppVoice();
    expect(await voice.registerForInAppCalls(async () => 'tok')).toBe(false);
    await expect(voice.placeInAppCall('o1', 'rider', { start: vi.fn(), cancel: vi.fn() })).rejects.toMatchObject({ code: 'INAPP_UNAVAILABLE' });
    expect(sdkState.imported).toBe(0);
  });
});

describe('[INAPP-CALLS] build 13 (module present)', () => {
  beforeEach(() => { rn.native = { TwilioVoiceReactNative: {} }; });

  it('app start: the iPhone PushKit registry and the role-line template, once', async () => {
    await voice.startInAppVoice();
    await voice.startInAppVoice();
    expect(sdkState.calls).toEqual([{ m: 'initializePushRegistry', a: [] }, { m: 'template', a: ['${swiftLine}'] }]);
  });

  it('Android: no PushKit, the same template', async () => {
    rn.os = 'android';
    await voice.startInAppVoice();
    expect(sdkState.calls).toEqual([{ m: 'template', a: ['${swiftLine}'] }]);
  });

  it('registers with a server token for its platform, at most every ten minutes; a refusal is quiet', async () => {
    const fetchToken = vi.fn(async (p: string) => `tok-${p}`);
    expect(await voice.registerForInAppCalls(fetchToken, 1_000_000)).toBe(true);
    expect(fetchToken).toHaveBeenCalledWith('ios');
    expect(await voice.registerForInAppCalls(fetchToken, 1_000_000 + 60_000)).toBe(false);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(await voice.registerForInAppCalls(async () => { throw new Error('403'); }, 1_000_000 + 11 * 60_000)).toBe(false);
  });

  it('a call: the server starts it, the SDK connects with ONLY the call id, the handle is "Swift"', async () => {
    const start = vi.fn(async () => ({ callId: 'cabc', token: 'tok' }));
    await voice.placeInAppCall('o1', 'rider', { start, cancel: vi.fn() });
    expect(start).toHaveBeenCalledWith('o1', 'rider', 'ios');
    expect(sdkState.calls.at(-1)).toEqual({ m: 'connect', a: ['tok', { params: { callId: 'cabc' }, contactHandle: 'Swift', notificationDisplayName: 'Swift' }] });
    expect(voice.inAppCallActive()).toBe(true);
    await voice.endInAppCall();
    expect(voice.inAppCallActive()).toBe(false);
  });

  it('a connect that fails frees the order at once (cancel) and reports the failure', async () => {
    sdkState.connectFails = true;
    const cancel = vi.fn(async () => undefined);
    await expect(voice.placeInAppCall('o1', 'rider', { start: async () => ({ callId: 'cabc', token: 'tok' }), cancel })).rejects.toThrow('connect failed');
    expect(cancel).toHaveBeenCalledWith('cabc');
    expect(voice.inAppCallActive()).toBe(false);
  });
});

describe('[INAPP-CALLS · SECURITY REVIEW] sign-out / account switch', () => {
  beforeEach(() => { rn.native = { TwilioVoiceReactNative: {} }; });

  it('unregisters with the token the OLD session fetched, and resets the throttle so the next account registers at once', async () => {
    const fetchToken = vi.fn(async (p: string) => `reg-${p}`);
    expect(await voice.registerForInAppCalls(fetchToken, 5_000_000)).toBe(true);
    expect(await voice.unregisterInAppCalls(async (p) => `old-session-${p}`)).toBe(true);
    expect(sdkState.calls.at(-1)).toEqual({ m: 'unregister', a: ['old-session-ios'] });
    // the very next registration (a new account, seconds later) is not throttled
    expect(await voice.registerForInAppCalls(fetchToken, 5_000_000 + 1_000)).toBe(true);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('a refused or failed unregister still resets the throttle and never throws', async () => {
    const fetchToken = vi.fn(async () => 'reg');
    await voice.registerForInAppCalls(fetchToken, 7_000_000);
    expect(await voice.unregisterInAppCalls(async () => { throw new Error('401'); })).toBe(false);
    expect(await voice.registerForInAppCalls(fetchToken, 7_000_000 + 1_000)).toBe(true);
  });

  it('a hung network never holds up the sign-out beyond the bound', async () => {
    vi.useFakeTimers();
    try {
      const pending = voice.unregisterInAppCalls(() => new Promise<string>(() => undefined));
      await vi.advanceTimersByTimeAsync(voice.UNREGISTER_TIMEOUT_MS + 1);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a build without the module: nothing to unregister, no SDK import', async () => {
    rn.native = {};
    voice.resetInAppVoiceForTests();
    expect(await voice.unregisterInAppCalls(async () => 'x')).toBe(false);
    expect(sdkState.imported).toBe(0);
  });
});

describe('[INAPP-CALLS] the microphone', () => {
  it('iPhone: the system asks with the purpose string; Swift adds nothing', async () => {
    const explain = vi.fn(async () => true);
    expect(await voice.ensureMicrophone(explain)).toBe(true);
    expect(explain).not.toHaveBeenCalled();
  });

  it('Android: already granted -> no words; otherwise Swift explains first, and "Not now" asks nothing', async () => {
    rn.os = 'android';
    const explain = vi.fn(async () => false);
    expect(await voice.ensureMicrophone(explain)).toBe(true);
    rn.granted = false;
    expect(await voice.ensureMicrophone(explain)).toBe(false);
    expect(explain).toHaveBeenCalledTimes(1);
    rn.requestResult = 'denied';
    expect(await voice.ensureMicrophone(async () => true)).toBe(false);
    rn.requestResult = 'granted';
    expect(await voice.ensureMicrophone(async () => true)).toBe(true);
  });
});
