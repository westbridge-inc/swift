/**
 * [INAPP-CALLS · owner 6 Nov 2026, "B"] The phone half of in-app calling: Twilio's
 * Voice React Native SDK (@twilio/voice-react-native-sdk 1.8.x), behind a guard.
 *
 * NATIVE-MODULE TRAP (memory: reference_swift_native_module_crash): the SDK throws
 * AT IMPORT when its native module is missing (src/common.ts: "if (typeof
 * nativeModule === 'undefined') throw"). Builds 11/12 have no such module, and an
 * over-the-air update carrying this file reaches them. So the SDK is never
 * imported statically: it is required only after NativeModules says the module
 * exists, inside a try/catch. On those builds `inAppVoiceAvailable()` is false,
 * "Call in app" never shows, and nothing else changes.
 *
 * What runs where:
 * - At every app start on a build that has the module: iOS initializes the SDK's
 *   PushKit registry (Apple: every VoIP push must be reported to CallKit, or iOS
 *   terminates the app; the SDK's registry does that), and both platforms set the
 *   call-screen template so an incoming call shows the server's role line
 *   ("Swift: your rider is calling about your order"), never a number.
 * - When the switch is on and the person is on a live order: register this phone
 *   with a short server token so it can be rung in the app.
 * - "Call in app": microphone permission (plain words first), then the server
 *   starts the call (party + cap checks) and the SDK connects with its call id.
 * Incoming calls are answered on the system's own call screen (CallKit on iPhone,
 * the call notification on Android); no JavaScript runs for that.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { CALL_SCREEN_TEMPLATE, OUTGOING_HANDLE } from '../lib/inAppCalls';
import type { CallTarget } from '../lib/callBridge';

/** The few SDK members Swift uses (structural, so this file type-checks without the SDK's types). */
interface SdkCall {
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
interface SdkVoice {
  initializePushRegistry(): Promise<void>;
  setIncomingCallContactHandleTemplate(template?: string): Promise<void>;
  register(token: string): Promise<void>;
  unregister(token: string): Promise<void>;
  connect(token: string, options?: { params?: Record<string, string>; contactHandle?: string; notificationDisplayName?: string }): Promise<SdkCall>;
}
interface SdkModule {
  Voice: new () => SdkVoice;
}

const NATIVE_NAME = 'TwilioVoiceReactNative';

let sdk: SdkModule | null | undefined;
function loadSdk(): SdkModule | null {
  if (sdk !== undefined) return sdk;
  sdk = null;
  try {
    if (!(NativeModules as Record<string, unknown>)[NATIVE_NAME]) return sdk;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@twilio/voice-react-native-sdk') as SdkModule;
    sdk = typeof mod?.Voice === 'function' ? mod : null;
  } catch {
    sdk = null;
  }
  return sdk;
}

let voice: SdkVoice | null = null;
function getVoice(): SdkVoice | null {
  if (voice) return voice;
  const mod = loadSdk();
  if (!mod) return null;
  try {
    voice = new mod.Voice();
  } catch {
    voice = null;
  }
  return voice;
}

/** Does this phone's app have in-app calling at all (build 13 and later)? */
export function inAppVoiceAvailable(): boolean {
  return getVoice() !== null;
}

let started = false;
/** App start: the PushKit registry (iPhone) and the call-screen template. Never throws. */
export async function startInAppVoice(): Promise<void> {
  if (started) return;
  const v = getVoice();
  if (!v) return;
  started = true;
  try {
    if (Platform.OS === 'ios') await v.initializePushRegistry();
  } catch { /* the next start tries again */ }
  try {
    await v.setIncomingCallContactHandleTemplate(CALL_SCREEN_TEMPLATE);
  } catch { /* the default handle is Swift's client name, never a number */ }
}

/** Platform name the server picks the push credential by. */
export function voicePlatform(): 'ios' | 'android' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

const REGISTER_EVERY_MS = 10 * 60_000;
let registeredAt = 0;
/**
 * Let this phone be rung in the app. `fetchToken` asks the server (only people on a live order get one).
 * At most every ten minutes; a refusal or failure is quiet (the phone bridge still reaches them).
 */
export async function registerForInAppCalls(fetchToken: (platform: 'ios' | 'android') => Promise<string>, now = Date.now()): Promise<boolean> {
  const v = getVoice();
  if (!v || now - registeredAt < REGISTER_EVERY_MS) return false;
  try {
    const token = await fetchToken(voicePlatform());
    await v.register(token);
    registeredAt = now;
    return true;
  } catch {
    return false;
  }
}

/** Bound so a slow network never holds up a sign-out. */
export const UNREGISTER_TIMEOUT_MS = 5_000;

/**
 * [SECURITY REVIEW, MEDIUM] Sign-out, account switch or a refused session: remove this phone's in-app call
 * binding BEFORE the session is torn down. `fetchToken` must ask the server with the OLD session's own
 * credentials (the token names that session's identity and no other). The throttle is reset whatever
 * happens, so the next account registers at once under its own identity. If this fails (offline, the session
 * already refused), the server still never rings the old identity: it is per session and the session is gone.
 */
export async function unregisterInAppCalls(fetchToken: (platform: 'ios' | 'android') => Promise<string>): Promise<boolean> {
  registeredAt = 0;
  const v = getVoice();
  if (!v) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => { await v.unregister(await fetchToken(voicePlatform())); return true; })();
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), UNREGISTER_TIMEOUT_MS); });
    return await Promise.race([work, timeout]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    registeredAt = 0;
  }
}

/**
 * Microphone, asked at the moment it is needed. Android: Swift's own words first (the system prompt has none).
 * iPhone: the system asks on the first call with the purpose string from app.config.ts.
 */
export async function ensureMicrophone(explain: () => Promise<boolean>): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const mic = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(mic)) return true;
  if (!(await explain())) return false;
  return (await PermissionsAndroid.request(mic)) === PermissionsAndroid.RESULTS.GRANTED;
}

let active: SdkCall | null = null;

/** Is an in-app call this phone placed still on? */
export function inAppCallActive(): boolean {
  return active !== null;
}

export interface PlaceDeps {
  start: (orderId: string, target: CallTarget, platform: 'ios' | 'android') => Promise<{ callId: string; token: string }>;
  cancel: (callId: string) => Promise<unknown>;
  onEnded?: () => void;
}

/** Start an in-app call. Throws (with a server code when there is one) when it could not start. */
export async function placeInAppCall(orderId: string, target: CallTarget, deps: PlaceDeps): Promise<void> {
  const v = getVoice();
  if (!v) throw Object.assign(new Error('in-app calling not available'), { code: 'INAPP_UNAVAILABLE' });
  const { callId, token } = await deps.start(orderId, target, voicePlatform());
  let call: SdkCall;
  try {
    call = await v.connect(token, { params: { callId }, contactHandle: OUTGOING_HANDLE, notificationDisplayName: OUTGOING_HANDLE });
  } catch (err) {
    // Twilio never took it: free the order at once rather than in a minute.
    await deps.cancel(callId).catch(() => undefined);
    throw err;
  }
  active = call;
  const ended = () => { if (active === call) active = null; deps.onEnded?.(); };
  try {
    call.on('disconnected', ended);
    call.on('connectFailure', ended);
  } catch { /* the call still runs; the button falls back to its idle state on the next render */ }
}

/** End the call this phone placed (the system call screen also ends it). */
export async function endInAppCall(): Promise<void> {
  const call = active;
  active = null;
  await call?.disconnect().catch(() => undefined);
}

/** Tests only. */
export function resetInAppVoiceForTests(): void {
  sdk = undefined; voice = null; started = false; registeredAt = 0; active = null;
}
