import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A KEYLESS ANDROID BUILD IS NOT AN APP WITH MISSING MAPS.
 *
 * Found by opening a live order on an Android emulator. The tracking screen did
 * not degrade — it died:
 *
 *   FabricUIManager: Exception thrown when executing UIFrameGuarded
 *   java.lang.RuntimeException: API key not found. ...
 *     at com.rnmaps.fabric.MapViewManager.createViewInstance(MapViewManager.java:164)
 *   BridgelessReact: ReactHost{0}.handleHostException(...)
 *
 * That last line is the whole point. `handleHostException` is the NATIVE host
 * path, not the JS one, so a React error boundary is not a fix that merely
 * needs writing — it is a fix that cannot work. In debug the redbox absorbs it.
 * A release build has no redbox.
 *
 * The config comment used to say a keyless build "renders a BLANK map". That
 * belief is exactly what would let such a build ship, so this file asserts both
 * halves: the gate exists, and the comment no longer promises a soft failure.
 *
 * The blast radius is asserted too, because it is the reason the gate is hard:
 * every screen that mounts a MapView is a screen a keyless build cannot open.
 */

const MOBILE = process.cwd();
const SRC = join(MOBILE, 'src');
const appConfig = readFileSync(join(MOBILE, 'app.config.ts'), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Config with comments stripped — the standing hazard-matching rule. The note
 *  in app.config.ts necessarily quotes the strings asserted on below. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const configCode = code(appConfig);

describe('a distributable Android build cannot ship without the maps key', () => {
  it('the gate throws rather than warning', () => {
    expect(configCode).toMatch(/ANDROID_GOOGLE_MAPS_API_KEY/);
    expect(configCode).toMatch(/throw new Error/);
  });

  it('the gate fires on EAS and on CI', () => {
    // Either alone leaves a real path to a keyless artifact.
    expect(configCode).toMatch(/EAS_BUILD/);
    expect(configCode).toMatch(/CI/);
  });

  it('a local build still runs, so the gate does not block unrelated work', () => {
    // A developer editing a screen with no map should not be stopped; they get
    // a warning naming the true consequence instead.
    expect(configCode).toMatch(/console\.warn/);
  });

  it('the key is still never committed — the gate reads it from the env', () => {
    // A gate that could be satisfied by a literal in this file would trade a
    // crash for a leaked key.
    expect(configCode).toMatch(/process\.env\['ANDROID_GOOGLE_MAPS_API_KEY'\]/);
    // A Google Maps key is 39 chars starting AIza. None may appear here.
    expect(appConfig).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  });
});

describe('the documented consequence matches the observed one', () => {
  it('nothing claims a keyless build merely renders a blank map', () => {
    // The original wording. It is wrong in the direction that ships a crash.
    expect(appConfig).not.toMatch(/renders a BLANK map without a key/);
  });

  it('the note says the failure is native and uncatchable', () => {
    expect(appConfig).toMatch(/native host exception/i);
    expect(appConfig).toMatch(/error boundary/i);
  });
});

describe('the blast radius is real, and is why the gate is hard', () => {
  const mapScreens = walk(SRC)
    .filter((f) => /from\s+'react-native-maps'/.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(SRC.length + 1));

  it('several screens mount a map, and a keyless build cannot open any of them', () => {
    // Not pinned to an exact count — screens come and go — but this must never
    // quietly fall to zero, which would read as "the gate is unnecessary now".
    expect(mapScreens.length).toBeGreaterThanOrEqual(5);
  });

  it('the flows named in the config note are among them', () => {
    // If one of these is renamed or dropped the note goes stale, and a stale
    // note is how the wrong belief came back the first time.
    const joined = mapScreens.join('\n');
    expect(joined).toMatch(/DeliveryScreen/); // customer order tracking
    expect(joined).toMatch(/ActiveJobScreen/); // the rider's live job
    expect(joined).toMatch(/PinConfirmScreen/); // the handover PIN
  });
});

describe('the gate does not block a build it cannot affect', () => {
  it('is narrowed to a build that produces an ANDROID artifact', () => {
    // The key is written into the `android` block and nowhere else — iOS maps
    // are Apple's. With no platform test, `eas build --platform ios` failed
    // with "Android needs ANDROID_GOOGLE_MAPS_API_KEY": a paid Apple account,
    // a finished app, and the first TestFlight build refused over a key that
    // could not have affected it.
    expect(configCode).toMatch(/EAS_BUILD_PLATFORM/);
    expect(configCode).toMatch(/buildsAndroidArtifact/);
    expect(configCode).toMatch(/!androidMapsApiKey && buildsAndroidArtifact/);
  });

  it('an UNKNOWN platform stays strict — CI builds both', () => {
    // The narrowing is expressed as "not ios", never as "is android". A plain
    // CI run sets no platform, and reading that as "not Android" would let a
    // keyless Android artifact through the exact gate this file exists for.
    expect(configCode).toMatch(/EAS_BUILD_PLATFORM'\] !== 'ios'/);
    expect(configCode).not.toMatch(/EAS_BUILD_PLATFORM'\] === 'android'/);
  });

  it('the key still only ever reaches the android config', () => {
    // If it were ever read on the iOS side, narrowing the gate by platform
    // would become unsafe.
    const androidBlock = configCode.slice(configCode.indexOf('android:'));
    expect(androidBlock).toMatch(/googleMaps/);
    const iosBlock = configCode.slice(configCode.indexOf('ios:'), configCode.indexOf('android:'));
    expect(iosBlock).not.toMatch(/androidMapsApiKey/);
  });
});

describe('what may and may not live in eas.json', () => {
  const eas = readFileSync(join(MOBILE, 'eas.json'), 'utf8');

  it('carries the Apple Team ID — it is public by design', () => {
    // A Team ID is published in /.well-known/apple-app-site-association at a
    // public URL, and authorises nothing on its own: signing needs private
    // certificates that live only in the Apple account.
    expect(JSON.parse(eas).submit.production.ios.appleTeamId).toMatch(/^[A-Z0-9]{10}$/);
  });

  it('carries NO Apple ID login, in a public repository', () => {
    // The opposite call to the Team ID, for the opposite reason. An Apple ID
    // is the account LOGIN — for the account that holds the signing
    // certificates — and this repository is public. `eas submit` prompts for
    // it, or reads EXPO_APPLE_ID from the environment.
    expect(eas).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(JSON.parse(eas).submit.production.ios.appleId).toBeUndefined();
  });

  it('carries no REPLACE_WITH placeholders', () => {
    // A placeholder parses as a value, so every check that asks "is it set?"
    // answers yes. An absent key is honest; a placeholder is a lie that
    // survives review.
    expect(eas).not.toMatch(/REPLACE_WITH/);
  });
});
