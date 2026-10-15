import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ slots: [] as any[], index: 0, userId: 'synthetic-subject', generation: 1,
  api: vi.fn(), request: vi.fn(), logout: vi.fn(), success: vi.fn(), error: vi.fn(), listener: null as null | (() => void) }));
vi.mock('react', async (original) => ({ ...await original<object>(),
  useCallback: (fn: any) => fn,
  useState: (initial: unknown) => { const i = h.index++; if (!(i in h.slots)) h.slots[i] = initial; return [h.slots[i], (next: unknown) => { h.slots[i] = next; }]; },
  useRef: (initial: unknown) => { const i = h.index++; return h.slots[i] ??= { current: initial }; },
  useEffect: (fn: () => unknown) => { const i = h.index++; if (!(i in h.slots)) { h.slots[i] = true; fn(); } },
}));
vi.mock('react-native', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', View: 'View', Share: {}, Platform: { OS: 'ios' } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: '' }, brand: { 50: '', 600: '' }, success: '' }, space: {} }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}), useMutation: (o: any) => ({ mutate: () => o.mutationFn().catch((e: unknown) => { o.onError?.(e); throw e; }) }) }));
vi.mock('../../../hooks/customer', () => ({ useProfile: () => ({ data: { firstName: 'Synthetic', lastName: 'Subject' } }) }));
vi.mock('../../../services/api', () => ({ customerApi: { deleteAccount: h.api, requestAccountClosure: h.request } }));
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: h.userId, generation: h.generation }),
  requireAuthSessionForPrincipal: (p: any) => { if (p.userId !== h.userId || p.generation !== h.generation) throw new Error('PRINCIPAL_CHANGED'); return p; },
  useAuthStore: Object.assign((select: any) => select({ logoutIfCurrent: h.logout }), { subscribe: (fn: () => void) => { h.listener = fn; return () => {}; } }),
}));
vi.mock('../../../components/StepUpSheet', () => ({ StepUpSheet: 'StepUpSheet' }));
vi.mock('../../../kit', () => Object.fromEntries(['ErrorState', 'Header', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T'].map((n) => [n, n])));
vi.mock('../../../kit/toast', () => ({ toast: { success: h.success, error: h.error } }));
import { PersonalDataScreen } from './PersonalDataScreen';
const cold = { response: { status: 403, data: { error: { code: 'STEP_UP_REQUIRED' } } } };
function find(node: any, type: string): any {
  if (!node || typeof node !== 'object') return;
  if (node.type === type && (type !== 'PillButton' || ['Delete my account', 'Request account closure'].includes(node.props.label))) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, type); if (result) return result; }
}
function render(closureRequest = false) { h.index = 0; return PersonalDataScreen({ route: { params: { closureRequest } }, navigation: { navigate: vi.fn() } }); }
beforeEach(() => { vi.clearAllMocks(); h.slots = []; h.index = 0; h.userId = 'synthetic-subject'; h.generation = 1; h.listener = null; });
describe('account closure uses the real step-up flow', () => {
  it.each([false, true])('waits for session verification before completing closure (request=%s)', async (request) => {
    const api = request ? h.request : h.api;
    api.mockRejectedValueOnce(cold).mockResolvedValueOnce({ data: { data: request ? { status: 'CLOSURE_REQUESTED', message: 'Request received' } : { deleted: true } } });
    const pending = find(render(request), 'PillButton').props.onPress();
    // Attach immediately so the old code's rejection is captured as red evidence.
    const result = Promise.resolve(pending).then(() => 'completed', () => 'rejected');
    await vi.waitFor(() => expect(find(render(request), 'StepUpSheet')?.props.visible).toBe(true));
    expect(h.logout).not.toHaveBeenCalled(); expect(h.success).not.toHaveBeenCalled(); expect(api).toHaveBeenCalledTimes(1);
    find(render(request), 'StepUpSheet').props.onVerified();
    expect(await result).toBe('completed'); expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls[1]![0]).toEqual(api.mock.calls[0]![0]);
    expect(h.logout).toHaveBeenCalledTimes(request ? 0 : 1);
    expect(h.success).toHaveBeenCalledOnce();
  });
  it('cancels pending erasure when the signed-in principal changes', async () => {
    h.api.mockRejectedValue(cold);
    const pending = find(render(), 'PillButton').props.onPress();
    const rejected = Promise.resolve(pending).then(() => null, (error) => error);
    await vi.waitFor(() => expect(find(render(), 'StepUpSheet')?.props.visible).toBe(true));
    const staleVerify = find(render(), 'StepUpSheet').props.onVerified;
    h.userId = 'different-synthetic-subject'; h.generation += 1; h.listener?.();
    await expect(rejected).resolves.toMatchObject({ name: 'StepUpDismissed' }); staleVerify();
    expect(h.api).toHaveBeenCalledOnce(); expect(h.logout).not.toHaveBeenCalled();
    expect(h.success).not.toHaveBeenCalled(); expect(h.error).not.toHaveBeenCalled();
  });
  it('dismissal leaves the account signed in without an error toast or a retry', async () => {
    h.api.mockRejectedValue(cold);
    const pending = find(render(), 'PillButton').props.onPress();
    const rejected = Promise.resolve(pending).then(() => null, (error) => error);
    await vi.waitFor(() => expect(find(render(), 'StepUpSheet')?.props.visible).toBe(true));
    find(render(), 'StepUpSheet').props.onClose(); await expect(rejected).resolves.toMatchObject({ name: 'StepUpDismissed' });
    expect(h.api).toHaveBeenCalledOnce(); expect(h.logout).not.toHaveBeenCalled(); expect(h.error).not.toHaveBeenCalled();
  });
});
