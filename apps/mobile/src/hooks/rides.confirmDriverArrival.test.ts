import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// [E19] Source contract for the passenger override: the mobile layers must all
// agree on the route, the hook, and the copy — a correct helper with a missing
// screen button is still a driver stranded at the door.
const strip = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const HOOK = strip(readFileSync(new URL('./rides.ts', import.meta.url), 'utf8'));
const TAXI = strip(readFileSync(new URL('../modules/movement/screens/TaxiScreen.tsx', import.meta.url), 'utf8'));
const DRIVER = strip(readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('passenger confirm-driver-arrival client contract', () => {
  it('rideApi calls the dedicated passenger route', () => {
    const rideApi = body(API, 'export const rideApi', '\n};');
    expect(rideApi).toContain('confirmDriverArrival: (id: string) => api.post(`/rides/${id}/confirm-driver-arrival`, {})');
    expect(rideApi).not.toContain('driverApi');
  });

  it('the hook invalidates both ride surfaces the status feeds', () => {
    const hook = body(HOOK, 'export function useConfirmDriverArrival', 'export function useRideSos');
    expect(hook).toContain('mutationFn: ({ id }: { id: string }) => unwrap(rideApi.confirmDriverArrival(id))');
    expect(hook).toContain("void qc.invalidateQueries({ queryKey: ['rides', 'active'] });");
    expect(hook).toContain('void qc.invalidateQueries({ queryKey: customerKeys.homeAll });');
  });

  it('the passenger screen shows the one-tap override only while the driver is en route', () => {
    expect(TAXI).toContain('const confirmDriverArrival = useConfirmDriverArrival();');
    const button = body(TAXI, "{status === 'DRIVER_EN_ROUTE' ? (", ') : null}');
    expect(button).toContain('label="My driver is here"');
    expect(button).toContain('confirmDriverArrival.mutate(');
    expect(button).toContain('{ id: ride.id }');
  });

  it('the driver app surfaces the gate refusal and names the passenger escape', () => {
    const onError = body(DRIVER, "if (step.action === 'arrived') {", 'onSuccess: () => {');
    expect(onError).toContain("Couldn't confirm arrival — try again or ask the passenger to confirm.");
    expect(onError).toContain('err?.details?.allowPassengerConfirm === true');
    expect(onError).toContain("If your GPS isn't working, ask the passenger to tap 'My driver is here'.");
    expect(onError).toContain('toast.show(');
  });
});
