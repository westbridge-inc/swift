import { beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ slots: [] as any[], index: 0, cleanup: null as null | (() => void), effects: false,
  pendingEffect: null as null | (() => (() => void)), principal: { userId: 'synthetic-a', generation: 1, accessToken: 'synthetic-rotation-a' },
  listener: null as null | (() => void) }));
// Minimal hook lifecycle harness: real production guard, no native UI/network.
vi.mock('react', () => ({ default: {},
  useCallback: (fn: any) => fn,
  useRef: (value: any) => { const i = harness.index++; return harness.slots[i] ??= { current: value }; },
  useState: (value: any) => { const i = harness.index++; if (!(i in harness.slots)) harness.slots[i] = value;
    return [harness.slots[i], (next: any) => { harness.slots[i] = next; }]; },
  useEffect: (fn: any) => { if (!harness.effects) { harness.effects = true; harness.pendingEffect = fn; } },
}));
vi.mock('react/jsx-runtime', () => ({ jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) }));
vi.mock('../components/StepUpSheet', () => ({ StepUpSheet: () => null }));
vi.mock('../stores/authStore', () => ({
  requireAuthSessionSnapshot: () => ({ ...harness.principal }),
  requireAuthSessionForPrincipal: (p: any) => {
    if (p.userId !== harness.principal.userId || p.generation !== harness.principal.generation) throw new Error('PRINCIPAL_CHANGED');
    return { ...harness.principal };
  },
  useAuthStore: { subscribe: (fn: any) => { harness.listener = fn; return () => { harness.listener = null; }; } },
}));
import { useStepUp } from './useStepUp';
const cold = { response: { status: 403, data: { error: { code: 'STEP_UP_REQUIRED' } } } };
function HarnessRender() { harness.index = 0; const value = useStepUp(); if (harness.pendingEffect) { harness.cleanup = harness.pendingEffect(); harness.pendingEffect = null; } return value; }
async function sheet() { await vi.waitFor(() => expect(harness.slots[0]).not.toBeNull()); return HarnessRender().sheet.props as any; }
beforeEach(() => {
  harness.slots = []; harness.index = 0; harness.cleanup = null; harness.effects = false; harness.pendingEffect = null; harness.listener = null;
  harness.principal = { userId: 'synthetic-a', generation: 1, accessToken: 'synthetic-rotation-a' };
});
describe('step-up retains original session and exactly one operation', () => {
  it('retries the exact body once after verification and permits token rotation', async () => {
    const control = HarnessRender(); const body = { method: 'NONE', store: 'synthetic-store' };
    const fn = vi.fn().mockRejectedValueOnce(cold).mockResolvedValue('saved');
    const promise = control.withStepUp(fn)(body); const props = await sheet();
    harness.principal.accessToken = 'synthetic-rotation-b'; harness.listener?.();
    props.onVerified(); props.onVerified();
    expect(await promise).toBe('saved'); expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[0]![0]).toBe(body); expect(fn.mock.calls[1]![0]).toBe(body);
  });
  it.each(['account', 'relogin', 'unmount', 'dismiss'])('%s cannot replay the pending mutation', async (change) => {
    const fn = vi.fn().mockRejectedValueOnce(cold).mockResolvedValue('wrong');
    const promise = HarnessRender().withStepUp(fn)('original'); const rejected = expect(promise).rejects.toBeDefined();
    const props = await sheet();
    if (change === 'account') { harness.principal.userId = 'synthetic-b'; harness.listener?.(); }
    if (change === 'relogin') { harness.principal.generation++; harness.listener?.(); }
    if (change === 'unmount') harness.cleanup?.();
    if (change === 'dismiss') props.onClose();
    props.onVerified(); await rejected; expect(fn).toHaveBeenCalledOnce();
  });
  it('a concurrent mutation cannot replace the pending authorization', async () => {
    const control = HarnessRender(); const first = vi.fn().mockRejectedValueOnce(cold).mockResolvedValue('first');
    const promise = control.withStepUp(first)(); const props = await sheet();
    const second = vi.fn().mockResolvedValue('second');
    await expect(control.withStepUp(second)()).rejects.toMatchObject({ name: 'StepUpDismissed' });
    expect(second).not.toHaveBeenCalled(); props.onVerified(); expect(await promise).toBe('first');
  });
  it('a second step-up refusal is not retried indefinitely', async () => {
    const fn = vi.fn().mockRejectedValue(cold); const promise = HarnessRender().withStepUp(fn)();
    const rejected = expect(promise).rejects.toBe(cold); (await sheet()).onVerified(); await rejected;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
