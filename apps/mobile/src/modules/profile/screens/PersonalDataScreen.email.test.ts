import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ slots: [] as any[], index: 0, effects: [] as Array<() => void>, cleanups: [] as Array<() => void>,
  listeners: new Set<() => void>(), current: { userId: 'email-owner', generation: 1, accessToken: 'synthetic-1' },
  profile: { id: 'email-owner', firstName: 'Synthetic', lastName: 'Profile', email: 'old@example.test', phone: '+5920000000' },
  update: vi.fn(), setUser: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('react', async (original) => ({ ...await original<object>(),
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => { const n = h.index++; return h.slots[n] ??= { current: initial }; },
  useState: (initial: unknown) => { const n = h.index++; if (!(n in h.slots)) h.slots[n] = initial; return [h.slots[n], (value: unknown) => { h.slots[n] = value; }]; },
  useEffect: (fn: () => void | (() => void)) => { const n = h.index++; if (h.slots[n]) return; h.slots[n] = true; h.effects.push(() => { const cleanup = fn(); if (cleanup) h.cleanups.push(cleanup); }); },
}));
vi.mock('react-native', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', View: 'View', Share: {}, Platform: { OS: 'ios' } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: '' }, brand: { 50: '', 600: '' }, success: '' }, space: {} }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: h.invalidate }), useMutation: (options: any) => ({ mutate: options.mutationFn }) }));
vi.mock('../../../hooks/customer', () => ({ useProfile: () => ({ data: h.profile }) }));
vi.mock('../../../services/api', () => ({ customerApi: { updateProfile: h.update } }));
vi.mock('../../../components/StepUpSheet', () => ({ StepUpSheet: 'StepUpSheet' }));
vi.mock('../../../stores/authStore', () => {
  class BoundaryError extends Error {}
  return {
    AuthSessionBoundaryError: BoundaryError,
    requireAuthSessionSnapshot: () => ({ ...h.current }),
    requireAuthSessionForPrincipal: (owner: any) => { if (owner.userId !== h.current.userId || owner.generation !== h.current.generation) throw new BoundaryError(); return { ...h.current }; },
    useAuthStore: Object.assign((select: any) => select({ setUserIfCurrent: h.setUser }), {
      getState: () => ({ user: { id: h.current.userId } }),
      subscribe: (fn: () => void) => { h.listeners.add(fn); return () => h.listeners.delete(fn); },
    }),
  };
});
vi.mock('../../../kit', () => Object.fromEntries(['ErrorState', 'Header', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T'].map((name) => [name, name])));
vi.mock('../../../kit/toast', () => ({ toast: { success: vi.fn() } }));
import { PersonalDataScreen } from './PersonalDataScreen';

function render() { h.index = 0; const tree = PersonalDataScreen(); h.effects.splice(0).forEach((fn) => fn()); return tree; }
function find(node: any, type: string, label?: string): any {
  if (!node || typeof node !== 'object') return;
  if (node.type === type && (!label || node.props.label === label)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, type, label); if (found) return found; }
}
const cold = { response: { status: 403, data: { error: { code: 'STEP_UP_REQUIRED' } } } };
async function begin() {
  render(); let tree = render();
  find(tree, 'LabeledInput', 'Email Address').props.onChangeText('new@example.test'); tree = render();
  const promise: Promise<unknown> = find(tree, 'PillButton', 'Save Changes').props.onPress();
  // Attach immediately so expected rejections cannot become unhandled.
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.waitFor(() => expect(find(render(), 'StepUpSheet')?.props.visible).toBe(true));
  return { settled, sheet: find(render(), 'StepUpSheet').props };
}
beforeEach(() => {
  vi.clearAllMocks(); h.update.mockReset(); h.slots = []; h.index = 0; h.effects = []; h.cleanups = []; h.listeners.clear();
  h.current = { userId: 'email-owner', generation: 1, accessToken: 'synthetic-1' };
  h.setUser.mockReturnValue(true);
  h.update.mockRejectedValueOnce(cold).mockResolvedValue({ data: { data: { ...h.profile, email: 'new@example.test' } } });
});
describe('Personal Data uses the real one-operation step-up guard', () => {
  it('retries the submitted email only once and accepts token rotation for the same session', async () => {
    const { settled, sheet } = await begin();
    find(render(), 'LabeledInput', 'Email Address').props.onChangeText('later-draft@example.test'); render();
    h.current.accessToken = 'synthetic-2'; h.listeners.forEach((fn) => fn());
    sheet.onVerified(); sheet.onVerified();
    expect(await settled).toHaveProperty('value'); expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.update.mock.calls[0]![0]).toEqual(h.update.mock.calls[1]![0]);
    expect(h.update.mock.calls[1]![0].email).toBe('new@example.test');
    expect(h.update.mock.calls[1]![1].accessToken).toBe('synthetic-2');
    expect(h.setUser).toHaveBeenCalledOnce(); expect(h.invalidate).toHaveBeenCalledOnce();
  });
  it.each(['dismiss', 'account', 'same-account-login', 'unmount'])('%s cannot retry or apply the profile', async (change) => {
    const { settled, sheet } = await begin();
    if (change === 'dismiss') sheet.onClose();
    if (change === 'account') { h.current.userId = 'other'; h.listeners.forEach((fn) => fn()); }
    if (change === 'same-account-login') { h.current.generation++; h.listeners.forEach((fn) => fn()); }
    if (change === 'unmount') h.cleanups.forEach((fn) => fn());
    sheet.onVerified(); expect(await settled).toHaveProperty('error');
    expect(h.update).toHaveBeenCalledOnce(); expect(h.setUser).not.toHaveBeenCalled(); expect(h.invalidate).not.toHaveBeenCalled();
  });
});
