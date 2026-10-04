import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: { userId: 'subject-a', generation: 1 },
  deleteAccount: vi.fn(), requestAccountClosure: vi.fn(), logout: vi.fn(), success: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<object>(), useEffect: () => undefined, useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock('react-native', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', View: 'View', Share: {}, Platform: { OS: 'ios' } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: '' }, brand: { 50: '', 600: '' }, success: '' }, space: {} }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
  useMutation: (options: { mutationFn: () => unknown }) => ({ mutate: options.mutationFn }),
}));
vi.mock('../../../hooks/customer', () => ({ useProfile: () => ({ data: { firstName: 'Synthetic', lastName: 'Subject' } }) }));
vi.mock('../../../services/api', () => ({ customerApi: { deleteAccount: mocks.deleteAccount, requestAccountClosure: mocks.requestAccountClosure } }));
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => mocks.owner,
  requireAuthSessionForPrincipal: () => mocks.owner,
  useAuthStore: (select: (state: unknown) => unknown) => select({ logoutIfCurrent: mocks.logout }),
}));
vi.mock('../../../kit', () => Object.fromEntries(['ErrorState', 'Header', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T'].map((name) => [name, name])));
vi.mock('../../../kit/toast', () => ({ toast: { success: mocks.success } }));
import { PersonalDataScreen } from './PersonalDataScreen';

function button(node: any): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === 'PillButton' && ['Delete my account', 'Request account closure'].includes(node.props.label)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = button(child); if (found) return found; }
}
beforeEach(() => vi.clearAllMocks());

describe('account deletion confirmation', () => {
  it('shows the pending erasure response and closes the local session', async () => {
    const message = 'Your account is closed. Some document erasure is pending; no further sign-in is needed.';
    mocks.deleteAccount.mockResolvedValue({ data: { data: { deleted: false, status: 'PENDING_DOCUMENT_ERASURE', message } } });
    await button(PersonalDataScreen()).props.onPress();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.deleteAccount).toHaveBeenCalledWith(mocks.owner);
    expect(mocks.logout).toHaveBeenCalledExactlyOnceWith(mocks.owner);
  });

  it('keeps a business closure request signed in with its receipt', async () => {
    const message = 'Closure request received. Track it in Help & Support.';
    mocks.requestAccountClosure.mockResolvedValue({ data: { data: { deleted: false, status: 'CLOSURE_REQUESTED', message } } });
    const navigate = vi.fn();
    await button(PersonalDataScreen({ route: { params: { closureRequest: true } }, navigation: { navigate } })).props.onPress();
    expect(mocks.requestAccountClosure).toHaveBeenCalledWith(mocks.owner);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('GetHelp');
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it.each(['PENDING_LEGAL_HOLD', 'PENDING_ACCOUNT_ERASURE'])('shows the honest %s receipt', async (status) => {
    const message = 'Your account is closed. Some erasure remains pending.';
    mocks.deleteAccount.mockResolvedValue({ data: { data: { deleted: false, status, message } } });
    await button(PersonalDataScreen()).props.onPress();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it('keeps the completed deletion confirmation for a completed response', async () => {
    mocks.deleteAccount.mockResolvedValue({ data: { data: { deleted: true } } });
    await button(PersonalDataScreen()).props.onPress();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith('Your account has been deleted.');
    expect(mocks.logout).toHaveBeenCalledExactlyOnceWith(mocks.owner);
  });
});
