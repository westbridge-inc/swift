import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [Row 55] Invites nobody has answered are never listed to the owner (that
// would show which typed numbers are Swift accounts), so a mistyped number is
// taken back together with every other unanswered invite. The component is
// called as a function (no RN renderer), as in TeamInviteCards.test.ts.

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), success: vi.fn(), error: vi.fn(), pending: false }));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../kit', () => ({ PillButton: 'PillButton', T: 'T' }));
vi.mock('../kit/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../hooks/vendorops', () => ({
  useWithdrawStaffInvites: () => ({ mutate: mocks.mutate, isPending: mocks.pending }),
}));

import { WithdrawStaffInvites } from './WithdrawStaffInvites';

function all(node: any, match: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (match(node)) out.push(node);
  for (const child of [node.props?.children].flat(Infinity)) all(child, match, out);
  return out;
}
const texts = (tree: any) => all(tree, (n) => n.type === 'T').map((n) => [n.props.children].flat().join(''));
const buttons = (tree: any) => all(tree, (n) => n.type === 'PillButton');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
});

describe('[row 55] the owner withdraws unanswered team invites', () => {
  it('says plainly what it does, with one button', () => {
    const tree = WithdrawStaffInvites();
    expect(texts(tree)).toEqual([
      'Typed a wrong number? Withdraw every invite nobody has answered yet. People already on your team stay.',
    ]);
    expect(buttons(tree).map((b) => b.props.label)).toEqual(['Withdraw unanswered invites']);
  });

  it('the button withdraws and shows the server\'s words; a failure shows the reason', () => {
    const [button] = buttons(WithdrawStaffInvites());
    button.props.onPress();
    expect(mocks.mutate).toHaveBeenCalledWith(undefined, expect.any(Object));
    const handlers = mocks.mutate.mock.calls.at(-1)![1];
    handlers.onSuccess({ withdrawn: true, message: 'Any invites from this store that were not answered yet have been withdrawn.' });
    expect(mocks.success).toHaveBeenLastCalledWith('Any invites from this store that were not answered yet have been withdrawn.');
    handlers.onError({ response: { data: { error: { message: 'Only the store owner can do this' } } } });
    expect(mocks.error).toHaveBeenLastCalledWith('Only the store owner can do this');
  });

  it('cannot be pressed twice while a withdraw is in flight', () => {
    mocks.pending = true;
    const [button] = buttons(WithdrawStaffInvites());
    expect(button.props.disabled).toBe(true);
  });

  it('the team section mounts it, and the client calls the withdraw route', () => {
    const screen = readFileSync(join(process.cwd(), 'src/modules/vendor/screens/VendorAccountScreen.tsx'), 'utf8');
    expect(screen).toMatch(/<WithdrawStaffInvites \/>/);
    const client = readFileSync(join(process.cwd(), 'src/services/api.ts'), 'utf8');
    expect(client).toContain("withdrawStaffInvites: () => api.post('/vendor/staff/invites/withdraw', {})");
  });
});
