vi.mock('../../../hooks/useStepUp', () => ({ useStepUp: () => ({ withStepUp: (fn: unknown) => fn, sheet: null, active: false }) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  owner: { userId: 'subject-a', generation: 1 },
  deleteAccount: vi.fn(), requestAccountClosure: vi.fn(), logout: vi.fn(), success: vi.fn(), error: vi.fn(),
  profile: { firstName: 'Synthetic', lastName: 'Subject' } as Record<string, unknown>,
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
  useMutation: (options: { mutationFn: () => unknown; onError?: (error: unknown) => void }) => ({
    mutate: async () => {
      try { return await options.mutationFn(); }
      catch (error) { if (!options.onError) throw error; options.onError(error); }
    },
  }),
}));
vi.mock('../../../hooks/customer', () => ({ useProfile: () => ({ data: mocks.profile }) }));
vi.mock('../../../services/api', () => ({ customerApi: { deleteAccount: mocks.deleteAccount, requestAccountClosure: mocks.requestAccountClosure } }));
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => mocks.owner,
  requireAuthSessionForPrincipal: () => mocks.owner,
  useAuthStore: (select: (state: unknown) => unknown) => select({ logoutIfCurrent: mocks.logout }),
}));
vi.mock('../../../kit', () => Object.fromEntries(['ErrorState', 'Header', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T'].map((name) => [name, name])));
vi.mock('../../../kit/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
import { PersonalDataScreen } from './PersonalDataScreen';

function button(node: any): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.type === 'PillButton' && ['Delete my account', 'Request account closure'].includes(node.props.label)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = button(child); if (found) return found; }
}
/** Every string rendered inside nodes of this kit type. */
function textOf(node: any, type: string, inside = false): string[] {
  if (typeof node === 'string') return inside ? [node] : [];
  if (!node || typeof node !== 'object') return [];
  const here = inside || node.type === type;
  return [node.props?.children].flat(Infinity).flatMap((child) => textOf(child, type, here));
}
beforeEach(() => { vi.clearAllMocks(); mocks.profile = { firstName: 'Synthetic', lastName: 'Subject' }; });

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

  // The server's own refusal words (partner-wind-down.ts BLOCKER_MESSAGE:
  // FEE_CREDIT with its amount filled in, and OPEN_CLAIM), shown as sent.
  it.each([
    'You have GY$1,500 paid for weekly fees that have not started. Open Get help and we\u2019ll refund it, then your account can be deleted.',
    'Swift has not finished paying a no-show claim it owes you. Wait for the payment, or open Get help to have it paid or closed, then return here to delete your account.',
  ])('shows the deletion refusal in the server words and keeps the session (%s)', async (message) => {
    mocks.deleteAccount.mockRejectedValue({ response: { status: 409, data: { error: { code: 'PARTNER_OBLIGATIONS', message } } } });
    await button(PersonalDataScreen()).props.onPress();
    expect(mocks.deleteAccount).toHaveBeenCalledExactlyOnceWith(mocks.owner);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('keeps the completed deletion confirmation for a completed response', async () => {
    mocks.deleteAccount.mockResolvedValue({ data: { data: { deleted: true } } });
    await button(PersonalDataScreen()).props.onPress();
    expect(mocks.success).toHaveBeenCalledExactlyOnceWith('Your account has been deleted.');
    expect(mocks.logout).toHaveBeenCalledExactlyOnceWith(mocks.owner);
  });

  it('a store or advertiser owner on the customer profile is asked to confirm a closure request, not a deletion', async () => {
    // [DS744 S3] The server opens a closure request for them and keeps the
    // account; the confirmation must not promise erasure that will not happen.
    mocks.profile = { ...mocks.profile, accountClosure: 'REQUEST' };
    const message = 'Your account closure request is received. Track it in Get help.';
    mocks.requestAccountClosure.mockResolvedValue({ data: { data: { deleted: false, status: 'CLOSURE_REQUESTED', message } } });
    const navigate = vi.fn();
    const tree = PersonalDataScreen({ navigation: { navigate } });
    expect(textOf(tree, 'PopupTitle')).toEqual(['Request account closure?']);
    expect(textOf(tree, 'PopupCard').join(' ')).not.toMatch(/cannot be undone|starts erasing/);
    await button(tree).props.onPress();
    expect(mocks.requestAccountClosure).toHaveBeenCalledWith(mocks.owner);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('GetHelp');
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('the profile\u2019s answer wins over the business screen\u2019s flag: store staff delete directly', async () => {
    // [Review S4] The store and advertiser screens open this screen as a
    // closure request, but staff who own nothing delete their own account.
    mocks.profile = { ...mocks.profile, accountClosure: 'DELETE' };
    mocks.deleteAccount.mockResolvedValue({ data: { data: { deleted: true } } });
    const tree = PersonalDataScreen({ route: { params: { closureRequest: true } }, navigation: { navigate: vi.fn() } });
    expect(textOf(tree, 'PopupTitle')).toEqual(['Delete your account?']);
    await button(tree).props.onPress();
    expect(mocks.deleteAccount).toHaveBeenCalledWith(mocks.owner);
    expect(mocks.requestAccountClosure).not.toHaveBeenCalled();
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it('with a server too old to answer, the business screen\u2019s flag still asks for a closure request', () => {
    const tree = PersonalDataScreen({ route: { params: { closureRequest: true } } });
    expect(textOf(tree, 'PopupTitle')).toEqual(['Request account closure?']);
  });

  it('a person whose Delete erases the account sees the deletion wording', () => {
    mocks.profile = { ...mocks.profile, accountClosure: 'DELETE' };
    const tree = PersonalDataScreen();
    expect(textOf(tree, 'PopupTitle')).toEqual(['Delete your account?']);
    expect(textOf(tree, 'PopupCard').join(' ')).toMatch(/cannot be undone/);
  });
});

// [Owner 16 Oct: customers take no photos · REVIEW-F #1837 S3-1] The screen is shared by every app. Only a
// person who HAS a picture (a partner's signup selfie) is told where it came from; a customer without one is
// never shown a line about a selfie.
describe('the photo line', () => {
  const SELFIE_LINE = 'Profile photo comes from your signup selfie.';
  it('a person with no picture (a customer) is never told about a signup selfie', () => {
    mocks.profile = { firstName: 'Synthetic', lastName: 'Subject', avatar: null };
    expect(textOf(PersonalDataScreen(), 'T').join(' ')).not.toMatch(/selfie/i);
  });
  it('a person with a picture (a partner) still sees where it came from', () => {
    mocks.profile = { firstName: 'Synthetic', lastName: 'Subject', avatar: 'https://example.invalid/a.jpg' };
    expect(textOf(PersonalDataScreen(), 'T')).toContain(SELFIE_LINE);
  });
});
