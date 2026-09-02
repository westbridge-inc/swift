import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [B6] The stacked-jobs UI, minimally — and the singular case untouched.
//
// SWIFT_BUILD_NOW Band B6: `useActiveJob` → `useActiveJobs` with the singular
// case rendering byte-identically; a run strip on MoverHomeScreen; the
// ActiveJobScreen becomes a stop list — ONE screen, never a tab per order —
// and each stop keeps its own PIN sheet, cash line and customer. These pin
// the shape so a later edit cannot quietly fork a second screen, or start
// adding money on the device.
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREEN = strip(readFileSync(new URL('./ActiveJobScreen.tsx', import.meta.url), 'utf8'));
const HOME = strip(readFileSync(new URL('./MoverHomeScreen.tsx', import.meta.url), 'utf8'));
const HOOK = strip(readFileSync(new URL('../../../hooks/mover.ts', import.meta.url), 'utf8'));

describe('the singular case is the old code path', () => {
  it('one leg renders from active.data exactly as before', () => {
    expect(SCREEN).toContain('const job: any = stacked ? (legs.find((l) => l.id === selectedLegId) ?? legs[0]) : active.data;');
    expect(SCREEN).toContain('const stacked = legs.length > 1;');
  });

  it('useActiveJob itself is untouched — the same query key, the same preview sample', () => {
    const single = HOOK.slice(HOOK.indexOf('export function useActiveJob('), HOOK.indexOf('export type RunSummary'));
    expect(single).toContain("queryKey: ['mover', 'active', kind],");
    expect(single).toContain('return pv ? PV.previewQuery(PV.PREVIEW_ACTIVE_JOB) : q;');
  });

  it('the legs query exists only for riders — taxi is one-at-a-time by law', () => {
    const legs = HOOK.slice(HOOK.indexOf('export function useActiveJobs('), HOOK.indexOf('export function useGoOnline('));
    expect(legs).toContain("const stacked = kind === 'RIDER' && !pv;");
    expect(legs).toContain('enabled: stacked,');
    expect(legs).toContain("queryKey: ['mover', 'active', kind, 'legs'],");
  });
});

describe('one screen, a stop list, each stop its own', () => {
  it('the stop chips render only when stacked, and switching a stop clears the PIN', () => {
    const chips = SCREEN.slice(SCREEN.indexOf('{stacked ? ('), SCREEN.indexOf('{/* Route + fare + live progress */}') > 0 ? SCREEN.indexOf('Route + fare') : SCREEN.length);
    expect(chips).toContain('legs.map((leg: any, i: number) =>');
    expect(chips).toContain("onPress={() => { setSelectedLegId(leg.id); setPin(''); }}");
    expect(chips).toContain('legStopLabel(leg)');
  });

  it('there is no second screen and no tab per order', () => {
    expect(SCREEN).not.toMatch(/createBottomTabNavigator|createMaterialTopTabNavigator/);
    expect(SCREEN.match(/export function \w+Screen\(/g)).toEqual(['export function ActiveJobScreen(']);
  });

  it('the PIN sheet, cash line and customer all read `job` — the selected stop', () => {
    expect(SCREEN).toContain("const isMmgPaid = door.kind === 'no-cash' && job?.paymentMethod === 'MOBILE_MONEY';");
    expect(SCREEN).toContain('const cust: any = job?.customer ?? job?.user ?? null;');
    expect(SCREEN).toContain('riderAct.mutate({ id: job.id,');
  });
});

describe('money on the strip is rendered, never added', () => {
  it('the home strip and the screen line print the server sum', () => {
    expect(HOME).toContain('${run.drops} drops · ${money(run.cashToCollect)} to collect · next: ${run.next.vendorName ?? \'pickup\'}');
    expect(SCREEN).toContain('{money(stackedJobs.run.cashToCollect)} to collect');
  });

  it('nothing sums totals on the device', () => {
    for (const src of [HOME, SCREEN, HOOK]) {
      expect(src).not.toMatch(/reduce\([^)]*totalAmount/);
      expect(src).not.toMatch(/cashToCollect\s*[-+*/]/);
    }
  });

  it('the singular banner copy is unchanged', () => {
    expect(HOME).toContain("{run ? 'ACTIVE RUN' : 'ACTIVE JOB'}");
    expect(HOME).toContain(": activeJob.deliveryAddress ?? activeJob.dropoffAddress ?? activeJob.orderNumber ?? 'In progress'}");
    expect(HOME).toContain("{run ? 'tap to manage the run' : `${jobAmount(activeJob)} · tap to manage`}");
  });
});
