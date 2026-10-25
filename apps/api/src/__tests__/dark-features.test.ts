import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DARK_FEATURES, darkFeatureMisconfigurations, darkFeatureStatus, darkFeaturesOff } from '../modules/ops/dark-features';
import { moverPushRequired } from '../modules/notification/mover-push-authority';
import { carDeliveriesEnabled } from '../config/vehicle-classes';
import { taxiMaxStops } from '../modules/rides/taxi-stops-flag';
import { taxiWaitingEnabled } from '../modules/rides/taxi-waiting';
import { adsEnabled } from '../modules/ads/ads-enabled';
import { ownerRlsBindEnabled } from '../lib/owner-rls';
import { mmgCheckoutEnabled } from '../providers/mmg/mmg-checkout';
import { webTaxiBookingEnabled } from '../modules/rides/web-taxi-booking';
import { oldAppsKeepCounterpartPhones } from '../modules/calls/counterpart-phone';
import { callRelayEnabled } from '../modules/calls/call-relay-switch';

// ---------------------------------------------------------------------------
// A capability may ship switched off. It may not ship switched off SILENTLY.
//
// Two shipped that way, and neither failed anything:
//
//   CATEGORY_DISCOVERY_ENABLED defaults false and nothing had ever set it, so
//   the category rail was dark in every database that has ever existed while
//   the client rendered the pre-rail Home pixel-identically.
//
//   APPLE_TEAM_ID / ANDROID_CERT_SHA256 gate the association files that make a
//   printed QR code open the app. Both 404 without them, the QR growth engine
//   quietly degrades to opening a browser tab, and neither variable appeared
//   in any .env.example — so no document would have told anyone to set them.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

describe('[dark features] every silent switch is registered', () => {
  it('names a setting, and says what a PERSON sees while it is off', () => {
    for (const f of DARK_FEATURES) {
      expect(f.setting, `${f.key} has no setting`).toBeTruthy();
      expect(f.whileOff.length, `${f.key} does not describe the experience`).toBeGreaterThan(40);
      // "Feature disabled" is not a consequence. The whole failure mode here is
      // that nothing looks wrong, so the entry has to say what the person sees.
      expect(/disabled|turned off|not enabled/i.test(f.whileOff), `${f.key} restates the switch instead of the consequence`).toBe(false);
    }
  });

  it('reads env switches, and never reports an unresolved config switch as ON', () => {
    const on = darkFeatureStatus({ ANDROID_CERT_SHA256: 'AA:BB' }, { CATEGORY_DISCOVERY_ENABLED: true });
    expect(on.find((r) => r.key === 'android_app_links')!.on).toBe(true);
    expect(on.find((r) => r.key === 'category_discovery')!.on).toBe(true);
    // A config switch with no answer supplied is NOT on.
    expect(darkFeatureStatus({}, {}).find((r) => r.key === 'category_discovery')!.on).toBe(false);
    expect(darkFeaturesOff(darkFeatureStatus({}, {})).map((r) => r.key)).toContain('android_app_links');
  });

  it('an exact-value switch is ON only at its value, never on mere presence', () => {
    // LIFECYCLE_V2='0' is a real, deliberate OFF — a register that reported it
    // ON because the variable is present would be the mirror-image lie this
    // file exists to prevent.
    const byKey = (env: Record<string, string | undefined>) => ({
      off: darkFeaturesOff(darkFeatureStatus(env, {})).map((r) => r.key),
    });
    expect(darkFeatureStatus({ LIFECYCLE_V2: '1' }, {}).find((r) => r.key === 'order_hold')?.on).toBe(true);
    expect(darkFeatureStatus({ LIFECYCLE_V2: '0' }, {}).find((r) => r.key === 'order_hold')?.on).toBe(false);
    expect(darkFeatureStatus({}, {}).find((r) => r.key === 'order_hold')?.on).toBe(false);
    expect(byKey({ LIFECYCLE_V2: '0' }).off).toContain('order_hold');
    expect(byKey({ LIFECYCLE_V2: '1' }).off).not.toContain('order_hold');
  });

  it('push before going online is registered, and reads exactly as the GO doors read it', () => {
    // [L07] Off is the deliberate launch posture; it still may not be silent.
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'true']) {
      const env = value === undefined ? {} : { MOVER_PUSH_REQUIRED: value };
      const row = darkFeatureStatus(env, {}).find((r) => r.key === 'mover_push_required');
      expect(row, 'MOVER_PUSH_REQUIRED is in the register').toBeTruthy();
      expect([value, row!.on]).toEqual([value, moverPushRequired(env)]);
    }
  });

  it('whitespace is not a fingerprint', () => {
    expect(darkFeatureStatus({ ANDROID_CERT_SHA256: '   ' }).find((r) => r.key === 'android_app_links')!.on).toBe(false);
  });

  it('a capability the CODE defaults is reported ON, with or without env', () => {
    // The mirror-image lie. A register that reports a capability off when the
    // code defaults it on sends an operator to fix something that is not
    // broken — and the next warning it prints gets ignored.
    //
    // iOS universal links are the live case: Swift's Team ID is now the default
    // in the AASA route, so the file serves with no configuration at all. The
    // env var still overrides it, which is why the entry stays registered.
    const ios = darkFeatureStatus({}, {}).find((r) => r.key === 'ios_universal_links')!;
    expect(ios.defaultedInCode, 'the entry claims no code default').toBeTruthy();
    expect(ios.on).toBe(true);
    expect(darkFeaturesOff(darkFeatureStatus({}, {})).map((r) => r.key)).not.toContain('ios_universal_links');
  });

  it('every claimed code default names where it lives, and is really there', () => {
    // A register entry may not simply ASSERT that the code defaults something.
    // That is the same unverified claim as a comment describing a gate — the
    // shape of defect this whole file exists to catch.
    for (const f of DARK_FEATURES.filter((x) => x.defaultedInCode)) {
      const parts = f.defaultedInCode!.split(' ');
      const value = parts[0] ?? '';
      const where = parts.slice(2).join(' ');
      expect(value, `${f.key} does not name the default value`).toBeTruthy();
      expect(where, `${f.key} does not say where the default lives`).toBeTruthy();
      const hay = [
        read('apps/web/src/app/well-known/apple-app-site-association/route.ts'),
        read('apps/web/src/app/well-known/assetlinks.json/route.ts'),
      ].join('\n');
      expect(hay.includes(value), `${f.key} claims a default of "${value}" that is nowhere in the code`).toBe(true);
    }
  });
});

describe('[dark features] the registry matches the code that reads the switch', () => {
  it('each env switch is actually read somewhere', () => {
    // A registry entry for a variable nothing consults is worse than no entry:
    // it tells an operator they have turned something on when they have not.
    const sources = [
      read('apps/api/src/utils/store-mmg.ts'),
      read('apps/web/src/app/well-known/apple-app-site-association/route.ts'),
      read('apps/web/src/app/well-known/assetlinks.json/route.ts'),
      read('apps/api/src/modules/safety/sos-escalation.ts'),
      read('apps/api/src/modules/discovery/discovery.routes.ts'),
      read('apps/api/src/modules/order/order.service.ts'),
      read('apps/api/src/modules/notification/mover-push-authority.ts'),
      // [row 331] the kill switches
      read('apps/api/src/modules/safety/ops-alert.ts'),
      read('apps/api/src/modules/safety/guardian-delivery.ts'),
      read('apps/api/src/modules/safety/guardian.service.ts'),
      read('apps/api/src/modules/safety/liveness.service.ts'),
      read('apps/api/src/modules/safety/trip-share.service.ts'),
      read('apps/api/src/utils/card-rail.ts'),
      read('apps/api/src/modules/admin/admin.routes.ts'),
      read('apps/api/src/modules/billing/settlement-import.ts'),
      read('apps/api/src/modules/rides/fare-zones.ts'),
      read('apps/api/src/modules/ads/checkout.service.ts'),
      read('apps/api/src/modules/ads/refund.service.ts'),
      read('apps/api/src/utils/mmg-pay-url.ts'),
      // [row 117] web taxi booking
      read('apps/api/src/modules/rides/web-taxi-booking.ts'),
      // [row 312] the upload malware gate
      read('apps/api/src/lib/malware-scan.ts'),
      // [SWITCHES fact-check 21 Oct] the launch switches that were missing
      read('apps/api/src/config/vehicle-classes.ts'),
      read('apps/api/src/modules/rides/taxi-stops-flag.ts'),
      read('apps/api/src/modules/rides/taxi-waiting.ts'),
      read('apps/api/src/modules/ads/ads-enabled.ts'),
      read('apps/api/src/lib/owner-rls.ts'),
      read('apps/api/src/providers/mmg/mmg-checkout.ts'),
      // [O-1] old builds' counterpart phones (retired with builds 9-12) + the call bridge switch
      read('apps/api/src/modules/calls/counterpart-phone.ts'),
      read('apps/api/src/modules/calls/call-relay-switch.ts'),
    ].join('\n');
    expect(sources.length, 'could not read the sources — the check cannot run').toBeGreaterThan(500);
    for (const f of DARK_FEATURES) {
      expect(sources.includes(f.setting), `${f.setting} is registered but nothing reads it`).toBe(true);
    }
  });

  it('every registered switch is documented where an operator would look', () => {
    // The gap that made these invisible was not the code — it was that no
    // .env.example mentioned them, so there was no document to consult.
    const docs = [read('apps/web/.env.example'), read('apps/mobile/.env.example'), read('apps/api/.env.example')].join('\n');
    for (const f of DARK_FEATURES.filter((x) => x.source === 'env')) {
      expect(docs.includes(f.setting), `${f.setting} appears in no .env.example — nothing would tell an operator it exists`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// [row 331 · CONFIG-GUARDS] A kill switch is a capability switched off by
// SETTING a variable: <NAME>_KILL=1. It starts cleanly and says nothing, which is
// exactly the failure this register exists for, so every one is registered and
// a switch left at 1 is printed by the preflight before a deploy. The census
// fails the day someone adds a *_KILL switch and does not register it.
// ---------------------------------------------------------------------------
describe('[row 331 · CONFIG-GUARDS] every kill switch the API reads is in the register', () => {
  const API_SRC = join(ROOT, 'apps/api/src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') walk(full, out);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  };
  const sources = walk(API_SRC).map((file) => ({ file: file.slice(API_SRC.length + 1), text: readFileSync(file, 'utf8') }));
  /** Every env read of a *_KILL variable, and how the code compares it. */
  const reads = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/\[\s*'([A-Z][A-Z0-9_]*_KILL)'\s*\]\s*(===|!==)?\s*('[^']*')?/g)].map((m) => ({ file, name: m[1]!, op: m[2], value: m[3] })));
  const kills = DARK_FEATURES.filter((f) => f.offWhen !== undefined);

  it('the census sees the switches it is about (the scan is not blind)', () => {
    const names = new Set(reads.map((r) => r.name));
    for (const name of ['SOS_ESCALATION_WORKER_KILL', 'OPS_ALERT_ESCALATION_KILL', 'CARD_RAIL_KILL', 'SETTLEMENT_PUBLISH_KILL']) {
      expect(names.has(name), `${name} is read somewhere in apps/api/src`).toBe(true);
    }
    expect(names.size).toBeGreaterThanOrEqual(12);
  });

  it('every *_KILL the API reads is registered, and every registered kill switch is read', () => {
    const read = [...new Set(reads.map((r) => r.name))].sort();
    expect(kills.map((f) => f.setting).sort()).toEqual(read);
  });

  it('the register reads each switch exactly as the code does: off at the value 1, and nowhere else', () => {
    for (const r of reads) {
      expect(r.op, `${r.file} reads ${r.name} without comparing it`).toBeDefined();
      expect(r.value, `${r.file} compares ${r.name} to something other than '1'`).toBe("'1'");
    }
    for (const f of kills) {
      expect(f.source, f.key).toBe('env');
      expect(f.offWhen, f.key).toBe('1');
      expect(f.enabledWhen, `${f.key} cannot be both a kill switch and an enable switch`).toBeUndefined();
      expect(f.defaultedInCode, f.key).toBeUndefined();
      const at = (value: string | undefined) => darkFeatureStatus(value === undefined ? {} : { [f.setting]: value }, {}).find((r) => r.key === f.key)!.on;
      expect(at('1'), `${f.setting}=1 is the capability OFF`).toBe(false);
      for (const value of [undefined, '', '0', 'true', ' 1']) expect(at(value), `${f.setting}=${JSON.stringify(value)}`).toBe(true);
    }
  });

  it('a kill switch left on is listed as off; the SOS escalation worker is a safety entry', () => {
    const off = darkFeaturesOff(darkFeatureStatus({ SOS_ESCALATION_WORKER_KILL: '1', CARD_RAIL_KILL: '1' }, {})).map((r) => r.setting);
    expect(off).toEqual(expect.arrayContaining(['SOS_ESCALATION_WORKER_KILL', 'CARD_RAIL_KILL']));
    expect(darkFeaturesOff(darkFeatureStatus({}, {})).map((r) => r.setting).filter((s) => s.endsWith('_KILL'))).toEqual([]);
    for (const setting of ['SOS_ESCALATION_WORKER_KILL', 'OPS_ALERT_ESCALATION_KILL', 'GUARDIAN_CHECKIN_DELIVERY_KILL', 'NOT_MY_DRIVER_AUTHORITY_KILL']) {
      expect(kills.find((f) => f.setting === setting)?.impact, setting).toBe('safety');
    }
  });
});

// ---------------------------------------------------------------------------
// [SWITCHES fact-check, 21 Oct] Six launch switches were read by the code and named nowhere an operator
// looks. Each is registered, read exactly as the code reads it, and written in the deploy template.
// ---------------------------------------------------------------------------
describe('[SWITCHES] the launch switches are registered and read exactly as the code reads them', () => {
  const SWITCHES: Array<[string, (env: Record<string, string | undefined>) => boolean]> = [
    ['CAR_DELIVERIES', (env) => carDeliveriesEnabled(env)],
    ['TAXI_MAX_STOPS', (env) => taxiMaxStops(env) > 0],
    ['TAXI_WAITING_CHARGE', (env) => taxiWaitingEnabled(env)],
    ['ADS_ENABLED', (env) => adsEnabled(env)],
    ['OWNER_RLS_BIND', (env) => ownerRlsBindEnabled(env)],
    ['MMG_CHECKOUT_ENABLED', (env) => mmgCheckoutEnabled(env)],
    ['WEB_TAXI_BOOKING', (env) => webTaxiBookingEnabled(env)],
    ['COUNTERPART_PHONES_TO_OLD_APPS', (env) => oldAppsKeepCounterpartPhones(env)],
    ['CALL_RELAY', (env) => callRelayEnabled(env)],
  ];
  const VALUES = [undefined, '', '0', '1', ' 1', '1 ', '2', '3', '9', '01', 'true', 'TRUE', 'yes', '-1', '1.5'];

  for (const [setting, code] of SWITCHES) {
    it(`${setting}: registered, and ON exactly when the code is on`, () => {
      const entry = DARK_FEATURES.find((f) => f.setting === setting);
      expect(entry, `${setting} is in the register`).toBeTruthy();
      expect(entry!.whileOff.length).toBeGreaterThan(60);
      for (const value of VALUES) {
        const env = value === undefined ? {} : { [setting]: value };
        const row = darkFeatureStatus(env, {}).find((r) => r.setting === setting)!;
        expect([setting, value, row.on]).toEqual([setting, value, code(env)]);
      }
    });
  }

  it('each is written in the deploy template an operator copies, and the production KYC rule is stated there', () => {
    const template = read('deploy/.env.deploy.example');
    for (const name of [...SWITCHES.map(([s]) => s), 'MALWARE_SCAN', 'CLAMD_HOST']) {
      expect(template, `${name} appears in deploy/.env.deploy.example`).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
    }
    expect(template).toMatch(/KYC_PROVIDER must be manual in production/);
  });

  it('the malware scan switched on with no scanner named is called out before a deploy: every upload would be refused', () => {
    expect(darkFeatureMisconfigurations({ MALWARE_SCAN: 'clamd' }).join(' ')).toMatch(/CLAMD_HOST/);
    expect(darkFeatureMisconfigurations({ MALWARE_SCAN: 'clamd', CLAMD_HOST: '  ' }).join(' ')).toMatch(/every upload is refused/);
    expect(darkFeatureMisconfigurations({ MALWARE_SCAN: 'clamd', CLAMD_HOST: 'clamd' })).toEqual([]);
    expect(darkFeatureMisconfigurations({})).toEqual([]);
    expect(read('deploy/preflight.ts')).toContain('darkFeatureMisconfigurations(production)');
  });
});
