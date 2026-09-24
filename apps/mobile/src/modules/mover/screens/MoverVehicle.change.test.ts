import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [VEHICLES · owner 2026-09-24] "after you save vehicle you cant switch it at
// all" (his test mover had saved a canter) and "take out extra vehicles like
// truck". Read as source: these screens pull in react-native, which Vitest
// cannot import; the wiring is what this pins. The server half (the change route,
// the launch list, papers following vehicles) is proven by
// apps/api/src/__tests__/vehicle-change.test.ts; the hook by hooks/authMutationFlows.
// ---------------------------------------------------------------------------

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const ONBOARDING = read('./MoverOnboardingScreen.tsx');
const VEHICLE = read('./MoverVehicleScreen.tsx');
const ACCOUNT = read('./MoverAccountScreen.tsx');
const STACK = read('../MoverStack.tsx');

describe('the picker offers only the vehicles Swift takes on', () => {
  it('lists the offered vehicles, never the raw fleet', () => {
    expect(ONBOARDING).toContain('const offered = VTYPES.filter((v) => vehicleOffered(v.key, pricing.data));');
    expect(ONBOARDING).toMatch(/\{offered\.map\(\(v\) => \(/);
    expect(ONBOARDING).not.toMatch(/\{VTYPES\.map\(/);
  });

  it('a saved vehicle that is no longer offered starts the picker on an offered one, and cannot be submitted', () => {
    expect(ONBOARDING).toContain('if (!vehicleOffered(vt, pricing.data) && offered[0]) setVt(offered[0].key);');
    expect(ONBOARDING).toContain('if (!vehicleOffered(vt, pricing.data)) return;');
  });
});

describe('a saved vehicle can be changed', () => {
  it('the saved card names the vehicle and offers Change; a canter says why it must change', () => {
    expect(ONBOARDING).toMatch(/<LinkText label=\{VEHICLE_COPY\.change\} onPress=\{\(\) => setChanging\(true\)\} \/>/);
    expect(ONBOARDING).toContain('{!savedOffered ? (');
    expect(ONBOARDING).toContain('{VEHICLE_COPY.notOffered}');
  });

  it('change mode calls the change route (not "Save vehicle" again), without re-asking the agreement', () => {
    expect(ONBOARDING).toContain("changeVehicle.mutate({ vehicleType: vt, vehicle }, { onSuccess: (r) => onDone(r?.changed !== false) });");
    expect(ONBOARDING).toContain("const needsAgreement = mode === 'join';");
    expect(ONBOARDING).toMatch(/\{needsAgreement \? \(\s*<Pressable\s+accessibilityRole="checkbox"/);
    expect(ONBOARDING).toMatch(/disabled=\{!gate\.ok \|\| !valid \|\| \(needsAgreement && !agree\) \|\| sameAsSaved\}/);
    // Join keeps its agreement: /become still sends acceptAgreement.
    expect(ONBOARDING).toContain("become.mutate({ role: 'MOVER', vehicleType: vt, vehicle, acceptAgreement: agree }, { onSuccess: () => onDone(true) });");
  });

  it('the server’s own words explain a refused change; a dismissed step-up says nothing', () => {
    expect(ONBOARDING).toContain('saving.error instanceof StepUpDismissed');
    expect(ONBOARDING).toContain('(saving.error as any)?.response?.data?.error?.message');
  });

  it('onboarding and the working mover’s screen both carry the step-up sheet the change may ask for', () => {
    expect(ONBOARDING).toMatch(/guard=\{stepUp\.withStepUp\}/);
    expect(ONBOARDING).toContain('{stepUp.sheet}');
    expect(VEHICLE).toMatch(/<VehicleSetup\s+mode="change"/);
    expect(VEHICLE).toMatch(/guard=\{stepUp\.withStepUp\}/);
    expect(VEHICLE).toContain('{stepUp.sheet}');
    // After a change the next stop is the new vehicle's papers.
    expect(VEHICLE).toContain("navigation?.navigate?.('MoverDocuments');");
  });

  it('a working mover reaches it from Account', () => {
    expect(ACCOUNT).toContain("label=\"Change vehicle\"");
    expect(ACCOUNT).toContain("navigation?.navigate?.('MoverVehicle')");
    expect(STACK).toContain('<Stack.Screen name="MoverVehicle" component={MoverVehicleScreen} />');
  });
});
