import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [Row 55] A store team invite is answered on the inbox. The card says who
// invited you and as what, in one plain sentence, with Accept and Decline —
// and nothing else. The component is called as a function (no RN renderer),
// as in PersonalDataScreen.test.ts; the data hooks are stubbed.

const mocks = vi.hoisted(() => ({
  invites: [] as unknown[],
  mutate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@swift/ui', () => ({ space: {} }));
vi.mock('../../../kit', () => ({ Card: 'Card', PillButton: 'PillButton', T: 'T' }));
vi.mock('../../../kit/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../../../hooks/teamInvites', async () => {
  const real = await vi.importActual<typeof import('../../../hooks/teamInvites')>('../../../hooks/teamInvites');
  return {
    teamInviteSentence: real.teamInviteSentence,
    useTeamInvites: () => ({ data: mocks.invites }),
    useAnswerTeamInvite: () => ({ mutate: mocks.mutate, isPending: false }),
  };
});
vi.mock('../../../services/api', () => ({ vendorApi: {} }));

import { TeamInviteCards } from './TeamInviteCards';

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
  mocks.invites = [];
});

describe('[row 55] the team invite card', () => {
  it('renders nothing when there is no invite', () => {
    expect(TeamInviteCards()).toBeNull();
  });

  it('says exactly who invited you and as what, with Accept and Decline only', () => {
    mocks.invites = [
      { id: 'inv-1', storeName: 'Test Kitchen', role: 'MANAGER', expiresAt: '2026-10-09T00:00:00.000Z', createdAt: '2026-10-06T00:00:00.000Z' },
      { id: 'inv-2', storeName: 'Corner Shop', role: 'STAFF', expiresAt: '2026-10-09T00:00:00.000Z', createdAt: '2026-10-06T00:00:00.000Z' },
    ];
    const tree = TeamInviteCards();
    expect(texts(tree)).toEqual([
      'Test Kitchen invited you to join their team as a manager.',
      'Corner Shop invited you to join their team as staff.',
    ]);
    expect(buttons(tree).map((b) => b.props.label)).toEqual(['Accept', 'Decline', 'Accept', 'Decline']);
  });

  it('Accept and Decline answer THAT invite, and say what happened', () => {
    mocks.invites = [{ id: 'inv-1', storeName: 'Test Kitchen', role: 'STAFF', expiresAt: 'x', createdAt: 'y' }];
    const [accept, decline] = buttons(TeamInviteCards());
    accept.props.onPress();
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: 'inv-1', decision: 'ACCEPT' }, expect.any(Object));
    mocks.mutate.mock.calls.at(-1)![1].onSuccess();
    expect(mocks.success).toHaveBeenLastCalledWith('You joined Test Kitchen. Open Swift Business to start.');

    decline.props.onPress();
    expect(mocks.mutate).toHaveBeenLastCalledWith({ id: 'inv-1', decision: 'DECLINE' }, expect.any(Object));
    mocks.mutate.mock.calls.at(-1)![1].onSuccess();
    expect(mocks.success).toHaveBeenLastCalledWith('Invite declined.');

    mocks.mutate.mock.calls.at(-1)![1].onError({ response: { data: { error: { message: 'This invite has expired. Ask the store owner to send a new one.' } } } });
    expect(mocks.error).toHaveBeenLastCalledWith('This invite has expired. Ask the store owner to send a new one.');
  });

  it('the inbox mounts the card, and the client calls the invite routes', () => {
    const inbox = readFileSync(join(process.cwd(), 'src/modules/profile/screens/NotificationsScreen.tsx'), 'utf8');
    expect(inbox).toMatch(/<TeamInviteCards \/>/);
    const client = readFileSync(join(process.cwd(), 'src/services/api.ts'), 'utf8');
    expect(client).toContain("teamInvites: () => api.get('/customer/team-invites')");
    expect(client).toContain('acceptTeamInvite: (id: string) => api.post(`/customer/team-invites/${id}/accept`, {})');
    expect(client).toContain('declineTeamInvite: (id: string) => api.post(`/customer/team-invites/${id}/decline`, {})');
  });
});
