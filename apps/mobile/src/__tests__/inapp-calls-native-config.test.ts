import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [INAPP-CALLS · owner 6 Nov 2026, "B" · build 13] What build 13 carries for in-app calls, and what it
// must not. plugins/withSwiftInAppCalls.js replaces the call SDK's own config plugin because, read from the
// SDK 1.8.1 package, that plugin (1) asks for the microphone, Bluetooth and notifications at EVERY start and
// keeps Swift over the lock screen with the screen always on, and (2) leaves Twilio's Firebase service in
// place, which would win over expo-notifications' and drop every ordinary Swift push on Android.
// The Kotlin edits are checked here on Expo-SDK-56-shaped templates; they are compiled for real only by an
// EAS build (no local native builds), so a native review + a two-phone device test stay owed (DESIGN.md §11).
// ---------------------------------------------------------------------------

const MOBILE = process.cwd();
const plugin = createRequire(join(MOBILE, 'package.json'))('./plugins/withSwiftInAppCalls.js') as { internals: Record<string, unknown> };
const I = plugin.internals as {
  wireMainApplication(src: string): string;
  wireMainActivity(src: string): string;
  wireAppGradle(src: string): string;
  wireManifest(m: unknown): { manifest: { $: Record<string, string>; application: Array<{ service: Array<{ $: Record<string, string>; 'intent-filter'?: unknown[] }> }> } };
  ROUTER_KT: string;
  INTENTS_KT: string;
  GATE_KT: string;
  CALL_ACTIONS: string[];
  OVER_LOCK_ACTIONS: string[];
  CALL_UUID_EXTRA: string;
  FIREBASE_MESSAGING_VERSION: string;
  VOICE_ANDROID_VERSION: string;
  TWILIO_FCM_SERVICE: string;
  EXPO_FCM_SERVICE: string;
  ROUTER_SERVICE: string;
};

const MAIN_ACTIVITY = `package gy.swift.app

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              super.invokeDefaultOnBackPressed()
          }
          return
      }
      super.invokeDefaultOnBackPressed()
  }
}
`;

const MAIN_APPLICATION = `package gy.swift.app

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Packages that cannot be autolinked yet can be added manually here, for example:
              // add(MyReactNativePackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
`;

const balanced = (src: string) => (src.match(/\{/g) ?? []).length === (src.match(/\}/g) ?? []).length;

describe('[INAPP-CALLS] MainActivity: call intents only, no prompt at start, never keeps the screen on', () => {
  const out = I.wireMainActivity(MAIN_ACTIVITY);

  it('forwards the intent in onCreate (after super) and in a new onNewIntent; idempotent', () => {
    expect(out).toMatch(/super\.onCreate\(null\)\n {4}SwiftCallIntents\.forward\(this, intent\) \/\/ @generated by swift-inapp-calls/);
    expect(out).toMatch(/override fun onNewIntent\(intent: Intent\) \{\n {4}super\.onNewIntent\(intent\)\n {4}SwiftCallIntents\.forward\(this, intent\)\n {2}\}/);
    expect(out).toContain('import android.content.Intent');
    expect(out).toContain('import gy.swift.app.calls.SwiftCallIntents');
    expect(balanced(out)).toBe(true);
    expect(I.wireMainActivity(out)).toBe(out);
  });

  it('never wires the SDK\'s VoiceActivityProxy (its onCreate prompts for permissions and sets the lock-screen + keep-on flags)', () => {
    expect(out).not.toContain('VoiceActivityProxy');
    expect(out).not.toMatch(/requestPermissions|RECORD_AUDIO|KEEP_SCREEN_ON/);
  });

  it('refuses to guess when another plugin already owns onNewIntent', () => {
    expect(() => I.wireMainActivity(MAIN_ACTIVITY.replace('override fun getMainComponentName', 'override fun onNewIntent(intent: Intent) {}\n  override fun getMainComponentName'))).toThrow(/already overrides onNewIntent/);
  });

  it('the intent helper: only the SDK\'s own actions reach VoiceService; never KEEP_SCREEN_ON', () => {
    expect(I.CALL_ACTIONS).not.toContain('ACTION_PUSH_APP_TO_FOREGROUND');
    expect(I.CALL_ACTIONS).toEqual(expect.arrayContaining(['ACTION_ACCEPT_CALL', 'ACTION_REJECT_CALL', 'ACTION_CALL_DISCONNECT', 'ACTION_FOREGROUND_AND_DEPRIORITIZE_INCOMING_CALL_NOTIFICATION']));
    expect(I.INTENTS_KT).toContain('"com.twiliovoicereactnative.VoiceService"');
    expect(I.INTENTS_KT).not.toContain('KEEP_SCREEN_ON');
    expect(balanced(I.INTENTS_KT)).toBe(true);
  });

  // [SECURITY REVIEW, MEDIUM: confused deputy] MainActivity is exported; the SDK's PendingIntents target it.
  it('an intent is forwarded ONLY when it names a call the SDK holds right now (its random call UUID); anything else is dropped', () => {
    expect(I.CALL_UUID_EXTRA).toBe('UUID'); // com.twiliovoicereactnative.Constants.MSG_KEY_UUID
    expect(I.INTENTS_KT).toContain('if (action == null || action !in CALL_ACTIONS || !SwiftCallGate.holdsCall(uuid)) {');
    // the drop branch returns before the forward, and clears the lock-screen flags unless a call is live
    const drop = I.INTENTS_KT.slice(I.INTENTS_KT.indexOf('!SwiftCallGate.holdsCall(uuid)) {'));
    expect(drop.indexOf('return')).toBeLessThan(drop.indexOf('startService'));
    expect(drop.slice(0, drop.indexOf('return'))).toContain('if (!SwiftCallGate.anyCall()) showOverLockScreen(activity, false)');
    expect(I.GATE_KT).toMatch(/^package com\.twiliovoicereactnative\n/);
    expect(I.GATE_KT).toContain('if (uuid !is UUID) return false');
    expect(I.GATE_KT).toContain('VoiceApplicationProxy.getCallRecordDatabase().get(CallRecordDatabase.CallRecord(uuid)) != null');
    expect(I.GATE_KT).toMatch(/catch \(e: Throwable\) \{\n {6}false/);
    expect(balanced(I.GATE_KT)).toBe(true);
  });

  it('over the lock screen only for the incoming-call screen or Answer, and cleared on every pause / stop / resume with no call left', () => {
    expect(I.OVER_LOCK_ACTIONS).toEqual(['ACTION_FOREGROUND_AND_DEPRIORITIZE_INCOMING_CALL_NOTIFICATION', 'ACTION_ACCEPT_CALL']);
    expect(I.INTENTS_KT).toContain('showOverLockScreen(activity, action in OVER_LOCK_ACTIONS)');
    expect(I.INTENTS_KT).toContain('private fun recheck(a: Activity) { if (!SwiftCallGate.anyCall()) showOverLockScreen(a, false) }');
    for (const hook of ['onActivityResumed', 'onActivityPaused', 'onActivityStopped']) {
      expect(I.INTENTS_KT).toContain(`override fun ${hook}(a: Activity) = recheck(a)`);
    }
  });

  it('the SDK facts the gate stands on (read from the installed package)', () => {
    const req = createRequire(join(MOBILE, 'package.json'));
    const java = (f: string) => readFileSync(join(req.resolve('@twilio/voice-react-native-sdk/package.json'), '..', 'android/src/main/java/com/twiliovoicereactnative', f), 'utf8');
    expect(java('Constants.java')).toContain('public static final String MSG_KEY_UUID = "UUID";');
    for (const a of I.CALL_ACTIONS) expect(java('Constants.java')).toContain(`public static final String ${a} = "${a}";`);
    expect(java('VoiceService.java')).toContain('intent.putExtra(Constants.MSG_KEY_UUID, uuid);');
    expect(java('VoiceApplicationProxy.java')).toMatch(/static CallRecordDatabase getCallRecordDatabase\(\)/);
    expect(java('CallRecordDatabase.java')).toContain('public CallRecord get(final CallRecord record)');
    expect(java('CallRecordDatabase.java')).toContain('public Collection<CallRecord> getCollection()');
  });
});

describe('[INAPP-CALLS] MainApplication: the SDK\'s application proxy', () => {
  it('declared once, created after super.onCreate(), torn down in onTerminate; idempotent', () => {
    const out = I.wireMainApplication(MAIN_APPLICATION);
    expect(out).toContain('private val voiceApplicationProxy = VoiceApplicationProxy(this)');
    expect(out).toMatch(/override fun onCreate\(\) \{\n {4}super\.onCreate\(\)\n {4}voiceApplicationProxy\.onCreate\(\) \/\/ @generated/);
    expect(out).toMatch(/override fun onTerminate\(\) \{\n {4}voiceApplicationProxy\.onTerminate\(\)\n {4}super\.onTerminate\(\)/);
    expect(out).toContain('import com.twiliovoicereactnative.VoiceApplicationProxy');
    expect(balanced(out)).toBe(true);
    expect(I.wireMainApplication(out)).toBe(out);
  });
});

describe('[INAPP-CALLS] ONE Firebase receiver: Twilio calls to the SDK, every other push to Expo as before', () => {
  const manifest = () => ({
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{ $: {}, service: [{ $: { 'android:name': 'expo.modules.audio.service.Other' } }] }],
    },
  });

  it('removes Twilio\'s and Expo\'s receivers and registers the router (not exported); keeps other services; idempotent', () => {
    const out = I.wireManifest(manifest());
    expect(out.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools');
    const services = out.manifest.application[0]!.service;
    expect(services.find((s) => s.$['android:name'] === I.TWILIO_FCM_SERVICE)!.$['tools:node']).toBe('remove');
    expect(services.find((s) => s.$['android:name'] === I.EXPO_FCM_SERVICE)!.$['tools:node']).toBe('remove');
    const router = services.find((s) => s.$['android:name'] === I.ROUTER_SERVICE)!;
    expect(router.$['android:exported']).toBe('false');
    expect(JSON.stringify(router['intent-filter'])).toContain('com.google.firebase.MESSAGING_EVENT');
    expect(services.some((s) => s.$['android:name'] === 'expo.modules.audio.service.Other')).toBe(true);
    const again = I.wireManifest(out);
    expect(again.manifest.application[0]!.service.filter((s) => JSON.stringify(s).includes('MESSAGING_EVENT'))).toHaveLength(1);
    expect(again.manifest.application[0]!.service).toHaveLength(4);
  });

  it('the router: a Twilio payload (twi_ keys) goes to the SDK and NEVER on to Expo (refused or thrown: logged); anything else goes to Expo', () => {
    expect(I.ROUTER_KT).toContain('class SwiftMessagingService : ExpoFirebaseMessagingService()');
    expect(I.ROUTER_KT).toContain('if (data.keys.any { it.startsWith("twi_") }) {');
    expect(I.ROUTER_KT).toContain('Voice.handleMessage(this, data, VoiceFirebaseMessagingService.MessageHandler(), CallMessageListenerProxy())');
    // [native review S3] the Twilio branch always returns; only a non-Twilio message reaches Expo
    const twilioBranch = I.ROUTER_KT.slice(I.ROUTER_KT.indexOf('if (data.keys.any'), I.ROUTER_KT.indexOf('super.onMessageReceived(remoteMessage)'));
    expect(twilioBranch).toMatch(/\} catch \(e: Throwable\) \{\n {8}Log\.e\(TAG, "the call SDK failed on a Twilio message", e\)\n {6}\}\n {6}return\n {4}\}\n {4}$/);
    expect(twilioBranch).not.toContain('super.');
    // the SDK's own 30-second wake of a dark screen for an incoming call
    expect(twilioBranch).toContain('if (!pm.isInteractive) {');
    expect(twilioBranch).toContain('pm.newWakeLock(PowerManager.SCREEN_DIM_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "SwiftMessagingService:incomingCall").acquire(30000)');
    expect(balanced(I.ROUTER_KT)).toBe(true);
  });

  it('compiles against the exact library versions the app ships (compileOnly, no second runtime copy)', () => {
    const gradle = I.wireAppGradle('apply plugin: "com.android.application"\n\ndependencies {\n    implementation("com.facebook.react:react-android")\n}\n');
    expect(gradle).toContain(`compileOnly("com.google.firebase:firebase-messaging:${I.FIREBASE_MESSAGING_VERSION}")`);
    expect(gradle).toContain(`compileOnly("com.twilio:voice-android:${I.VOICE_ANDROID_VERSION}")`);
    expect(I.wireAppGradle(gradle)).toBe(gradle);
    const req = createRequire(join(MOBILE, 'package.json'));
    const sdkGradle = readFileSync(join(req.resolve('@twilio/voice-react-native-sdk/package.json'), '..', 'android/build.gradle'), 'utf8');
    expect(sdkGradle).toContain(`'voiceAndroid'       : '${I.VOICE_ANDROID_VERSION}'`);
    const notifGradle = readFileSync(join(req.resolve('expo-notifications/package.json'), '..', 'android/build.gradle'), 'utf8');
    expect(notifGradle).toContain(`com.google.firebase:firebase-messaging:${I.FIREBASE_MESSAGING_VERSION}`);
    expect(JSON.parse(readFileSync(join(MOBILE, 'package.json'), 'utf8')).dependencies['@twilio/voice-react-native-sdk']).toBe('1.8.1');
  });
});

type AppConfig = {
  ios: { infoPlist?: Record<string, unknown> };
  android: { blockedPermissions?: string[] };
  plugins: unknown[];
};
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
async function loadConfig(): Promise<AppConfig> {
  vi.stubEnv('ANDROID_GOOGLE_MAPS_API_KEY', 'test-maps-key');
  return (await import('../../app.config')).default as unknown as AppConfig;
}

describe('[INAPP-CALLS] app.config.ts', () => {
  it('one microphone purpose string (calls only, never records), voip + audio modes, RECORD_AUDIO not blocked, the plugin listed', async () => {
    const config = await loadConfig();
    const mic = config.ios.infoPlist?.['NSMicrophoneUsageDescription'];
    expect(mic).toBe('Swift uses the microphone only during in-app calls with your rider, driver, store or customer. Swift never records calls.');
    expect(config.ios.infoPlist?.['UIBackgroundModes']).toEqual(['location', 'remote-notification', 'fetch', 'voip', 'audio']);
    expect(config.android.blockedPermissions).toEqual(['android.permission.SYSTEM_ALERT_WINDOW']);
    expect(config.plugins).toContain('./plugins/withSwiftInAppCalls.js');
    expect(config.plugins).not.toContain('@twilio/voice-react-native-sdk');
    // `false` would DELETE the purpose string (and image-picker would block RECORD_AUDIO): every plugin gets the same words
    for (const name of ['expo-audio', 'expo-camera', 'expo-image-picker']) {
      const entry = config.plugins.find((p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === name)!;
      expect(entry[1]['microphonePermission'], name).toBe(mic);
    }
  });
});

// The real Expo plugin pipeline in introspect mode (in memory, writes nothing): what an EAS build of this
// config puts in Info.plist and the app's AndroidManifest (Kotlin/Gradle mods do not run in introspect).
const COMPILE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.cwd();
const fromExpo = createRequire(createRequire(path.join(root, 'package.json')).resolve('expo/package.json'));
const { getPrebuildConfigAsync } = fromExpo('@expo/prebuild-config');
const { compileModsAsync } = fromExpo('@expo/config-plugins');
(async () => {
  const { exp } = await getPrebuildConfigAsync(root, { platforms: ['ios', 'android'] });
  const out = await compileModsAsync(exp, { projectRoot: root, introspect: true, platforms: ['ios', 'android'], assertMissingModProviders: false });
  const r = out._internal.modResults;
  const manifest = r.android.manifest.manifest;
  process.stdout.write('\\n@@OUT@@' + JSON.stringify({
    plist: r.ios.infoPlist,
    permissions: (manifest['uses-permission'] || []).map((p) => ({ name: p.$['android:name'], node: p.$['tools:node'] })),
    services: (manifest.application[0].service || []).map((s) => ({ name: s.$['android:name'], node: s.$['tools:node'], fcm: JSON.stringify(s['intent-filter'] || []).includes('MESSAGING_EVENT') })),
  }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

describe('[INAPP-CALLS] what an EAS build of this config really carries', () => {
  it('iOS: microphone string + voip/audio; Android: RECORD_AUDIO not removed, exactly one live Firebase receiver (the router)', () => {
    const raw = execFileSync(process.execPath, ['-e', COMPILE], {
      cwd: MOBILE,
      env: { ...process.env, ANDROID_GOOGLE_MAPS_API_KEY: 'test-maps-key', EAS_BUILD_PLATFORM: '' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = JSON.parse(raw.slice(raw.lastIndexOf('@@OUT@@') + 7)) as {
      plist: Record<string, unknown>;
      permissions: Array<{ name: string; node?: string }>;
      services: Array<{ name: string; node?: string; fcm: boolean }>;
    };
    expect(out.plist['NSMicrophoneUsageDescription']).toMatch(/only during in-app calls.*never records calls/);
    expect(out.plist['UIBackgroundModes']).toEqual(expect.arrayContaining(['voip', 'audio']));
    expect(out.permissions).not.toContainEqual({ name: 'android.permission.RECORD_AUDIO', node: 'remove' });
    expect(out.services.filter((s) => s.fcm && s.node !== 'remove').map((s) => s.name)).toEqual([I.ROUTER_SERVICE]);
    expect(out.services).toContainEqual({ name: I.TWILIO_FCM_SERVICE, node: 'remove', fcm: false });
    expect(out.services).toContainEqual({ name: I.EXPO_FCM_SERVICE, node: 'remove', fcm: false });
  }, 120_000);
});
