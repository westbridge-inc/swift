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

/** The app always loads the real package; tests hand in their own (a Metro `require` is not a vitest module). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultLoad = (): unknown => require('@twilio/voice-react-native-sdk');
let load: () => unknown = defaultLoad;

let sdk: SdkModule | null | undefined;
function loadSdk(): SdkModule | null {
  if (sdk !== undefined) return sdk;
  sdk = null;
  try {
    // Never evaluated on a binary without the native module (the SDK throws at import there).
    if (!(NativeModules as Record<string, unknown>)[NATIVE_NAME]) return sdk;
    const mod = load() as SdkModule | null | undefined;
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

/**
 * [native review 5] "This phone has registered to be rung in the app" survives restarts (a plain flag, nothing
 * personal). Until a phone first registers, Twilio has no binding for it and Apple no VoIP token, so no VoIP push
 * can ever reach it: the SDK (CallKit, audio, PushKit) is not started at all. Once it has registered, the PushKit
 * registry starts at EVERY launch, before any network answer, because a VoIP push may be what launched the app
 * and iOS ends an app that does not report it to CallKit at once. The flag clears after a successful unregister.
 */
const FLAG_KEY = 'registeredOnce';
export interface FlagStore { getBoolean(k: string): boolean | undefined; set(k: string, v: boolean): void; delete(k: string): void }
/** A plain (not encrypted) MMKV file: readable at once at launch, before the Keychain is open. Loaded lazily, so
 *  screens that import this file do not load the storage module at import. */
const defaultFlags = (): FlagStore => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MMKV } = require('react-native-mmkv') as { MMKV: new (o: { id: string }) => FlagStore };
  return new MMKV({ id: 'swift-inapp-calls' });
};
let makeFlags: () => FlagStore = defaultFlags;
let flagStore: FlagStore | null | undefined;
function flags() {
  if (flagStore !== undefined) return flagStore;
  try { flagStore = makeFlags(); } catch { flagStore = null; }
  return flagStore;
}
function registeredOnce(): boolean {
  try { return flags()?.getBoolean(FLAG_KEY) === true; } catch { return false; }
}
function setRegisteredOnce(on: boolean): void {
  try { if (on) flags()?.set(FLAG_KEY, true); else flags()?.delete(FLAG_KEY); } catch { /* best effort */ }
}

/** App start: the calling SDK only on a phone that has registered for in-app calls before (see above). */
export async function startInAppVoiceIfRegistered(): Promise<void> {
  if (!registeredOnce()) return;
  await startInAppVoice();
}

let started = false;
/** The PushKit registry (iPhone) and the call-screen template. Never throws. */
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
/** iPhone: PushKit hands the VoIP token over shortly after the registry starts; one retry after this wait. */
export const FIRST_REGISTER_RETRY_MS = 2_000;
let registeredAt = 0;

export type VoiceTokenFetch = (platform: 'ios' | 'android', purpose: 'register' | 'unregister') => Promise<string>;

/** Android: may the SDK ring this phone? It silently drops a ring without the microphone (Android 11+). Never asks. */
async function canBeRung(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iPhone: CallKit rings; the system asks for the microphone on Answer
  try { return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO); } catch { return false; }
}

/**
 * Let this phone be rung in the app. `fetchToken` asks the server (only people on a live order get one; the
 * server rings only phones that registered). At most every ten minutes; a refusal or failure is quiet (the
 * phone bridge still reaches them).
 * [native review S2] Android without the microphone: never registers (and removes an earlier registration), so
 * the server sends their calls to the phone bridge instead of a ring the SDK would drop.
 */
export async function registerForInAppCalls(fetchToken: VoiceTokenFetch, now = Date.now(), wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<boolean> {
  const v = getVoice();
  if (!v || now - registeredAt < REGISTER_EVERY_MS) return false;
  if (!(await canBeRung())) {
    if (registeredAt > 0 || registeredOnce()) await unregisterInAppCalls((platform) => fetchToken(platform, 'unregister'));
    return false;
  }
  const firstStart = !started;
  await startInAppVoice();
  const attempt = async () => { await v.register(await fetchToken(voicePlatform(), 'register')); };
  try {
    try {
      await attempt();
    } catch (err) {
      if (!(firstStart && Platform.OS === 'ios')) throw err;
      await wait(FIRST_REGISTER_RETRY_MS);
      await attempt();
    }
    registeredAt = now;
    setRegisteredOnce(true);
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
  const wasRegistered = registeredAt > 0 || registeredOnce();
  registeredAt = 0;
  const v = getVoice();
  // [native review 4] Never registered on this phone (in-app calls off, or never offered): nothing to remove,
  // no request at all, sign-out goes straight on.
  if (!v || !wasRegistered) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => { await v.unregister(await fetchToken(voicePlatform())); setRegisteredOnce(false); return true; })();
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
  await startInAppVoice(); // CallKit / the call-screen template, if this phone has not started them yet
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

/** Tests only: forget everything; `loader` stands in for the package (default: the real one). */
export function resetInAppVoiceForTests(loader: () => unknown = defaultLoad, flagsFactory: () => FlagStore = defaultFlags): void {
  sdk = undefined; voice = null; started = false; registeredAt = 0; active = null; load = loader;
  flagStore = undefined; makeFlags = flagsFactory;
}
