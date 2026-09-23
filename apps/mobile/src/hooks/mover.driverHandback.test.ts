import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source contracts complement the pure state test: this feature crosses four
// layers, and a correct helper with a missing route call is still a dead control.
const strip = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const HOOK = strip(readFileSync(new URL('./mover.ts', import.meta.url), 'utf8'));
const SCREEN = strip(readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8'));
const SERVER = strip(readFileSync(new URL('../../../api/src/modules/driver/driver.routes.ts', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('driver ride handback client/server contract', () => {
  it('uses the dedicated driver cancel route, never the passenger route', () => {
    const driverApi = body(API, 'export const driverApi', '\n};');
    expect(driverApi).toContain('handback: (id: string, reason: string) => api.post(`/driver/rides/${id}/cancel`, { reason })');
    expect(driverApi).not.toContain('api.post(`/rides/${id}/cancel`');
    expect(SERVER).toContain("app.post('/rides/:id/cancel'");
    expect(SERVER).toContain('driverCancelSchema.parse(request.body ?? {})');
  });

  it('requires a reason and sends it through the driver action hook', () => {
    expect(HOOK).toContain("| { id: string; action: 'handback'; reason: string }");
    const hook = body(HOOK, 'export function useDriverAction', 'export type RiderAction');
    expect(hook).toContain("if (input.action === 'handback') return unwrap(driverApi.handback(id, input.reason));");
    expect(hook).toContain("queryKey: ['mover']");
  });

  it('does not await the handback refetch before the screen success callback', () => {
    const hook = body(HOOK, 'export function useDriverAction', 'export type RiderAction');
    const success = body(hook, 'onSuccess: (_data, input) => {', '\n  });');

    expect(success).toContain("if (input.action === 'handback') {");
    expect(success).toContain("void qc.invalidateQueries({ queryKey: ['mover'] });");
    expect(success).toContain("return qc.invalidateQueries({ queryKey: ['mover'] });");
    expect(success).not.toContain("await qc.invalidateQueries({ queryKey: ['mover'] })");
  });

  it('offers a ride-bound two-step choice and keeps backend failure visible', () => {
    expect(SCREEN).toContain('const canDriverHandback = isDriver && canDriverHandbackRide(liveJob);');
    expect(SCREEN).toContain('label="Can\'t complete this ride"');
    expect(SCREEN).toContain('if (!liveJob?.id || !canDriverHandback) return;');
    expect(SCREEN).toContain("setDriverHandbackFlow({ rideId: liveJob.id, job: liveJob, phase: 'confirm' });");
    expect(SCREEN).toContain("phase: 'confirm' | 'submitting' | 'dismissing';");
    expect(SCREEN).toContain("['Vehicle problem', 'Road or access blocked', 'Passenger did not arrive']");
    expect(SCREEN).toContain('onError: (e: any) =>');
  });

  it('uses the snapshot only as a submitting/dismissing host, never as action authority', () => {
    expect(SCREEN).toContain("const retainDriverHandbackHost = driverHandbackFlow?.phase === 'submitting' || driverHandbackFlow?.phase === 'dismissing';");
    expect(SCREEN).toContain('const job: any = liveJob ?? (retainDriverHandbackHost ? driverHandbackFlow?.job : null) ?? null;');
    expect(SCREEN).toContain("if (driverHandbackFlow?.phase !== 'confirm') return;");
    expect(SCREEN).toContain("if (canDriverHandback && liveJob?.id === driverHandbackFlow.rideId) return;");
    expect(SCREEN).toContain("toast.show('Ride updated', 'This ride can no longer be handed back.');");

    const popup = body(SCREEN, '<PopupCard\n        visible={!!driverHandbackFlow', '<PopupCard visible={handbackConfirm}');
    const press = body(popup, 'onPress={() => {\n              if (preview', 'onSuccess: () => {');
    expect(press).toContain("!liveJob?.id");
    expect(press).toContain('driverHandbackFlow.rideId !== liveJob.id');
    expect(press).toContain('const rideId = liveJob.id;');
    expect(press).toContain("phase: 'submitting'");
    expect(press).toContain("{ id: rideId, action: 'handback', reason: why }");
    expect(press).not.toContain('job.id');
  });

  it('dismisses the native popup before navigating after success', () => {
    const popup = body(
      SCREEN,
      '<PopupCard\n        visible={!!driverHandbackFlow',
      '<PopupCard visible={handbackConfirm}',
    );
    const success = body(popup, 'onSuccess: () => {', 'onError: (e: any) =>');
    const dismissal = body(
      SCREEN,
      'const finishDriverHandbackDismissal = useCallback(() => {',
      'const isCourier =',
    );

    expect(success).toContain('driverHandbackNavigateAfterDismissRef.current = true;');
    expect(success).toContain("setDriverHandbackFlow((flow) => flow && flow.rideId === rideId ? { ...flow, phase: 'dismissing' } : flow);");
    expect(success).not.toContain('navigation?.goBack?.()');
    expect(success).not.toContain('finishDriverHandbackDismissal');
    expect(popup).toContain('onDismissed={finishDriverHandbackDismissal}');
    expect(dismissal).toContain('if (!driverHandbackNavigateAfterDismissRef.current) return;');
    expect(dismissal).toContain('driverHandbackNavigateAfterDismissRef.current = false;');
    expect(dismissal).toContain('navigation?.goBack?.();');
  });

  it('uses the native dismissal on iOS and a cancellable two-frame fallback elsewhere', () => {
    const fallback = body(
      SCREEN,
      "if (Platform.OS === 'ios' || driverHandbackFlow?.phase !== 'dismissing') return;",
      "if (!job && !ratePopup) {",
    );

    expect(fallback).toContain('requestAnimationFrame(() => {');
    expect((fallback.match(/requestAnimationFrame/g) ?? []).length).toBe(2);
    expect(fallback).toContain('requestAnimationFrame(finishDriverHandbackDismissal)');
    expect(fallback).toContain('cancelAnimationFrame(firstFrame);');
    expect(fallback).toContain('cancelAnimationFrame(secondFrame);');
  });
});
