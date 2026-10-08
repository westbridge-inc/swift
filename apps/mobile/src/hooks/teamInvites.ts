import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customerApi } from '../services/api';
import { teamInviteKeys } from './teamInviteKeys';
export { teamInviteKeys } from './teamInviteKeys';

// [Row 55] A store owner's "add to team" sends an invite; the person joins
// only by accepting it here. Nothing about them reaches the store before that.

export interface TeamInvite {
  id: string;
  storeName: string;
  role: 'MANAGER' | 'STAFF';
  expiresAt: string;
  createdAt: string;
}

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

/** The one sentence an invite card says — plain, and only what is true. */
export function teamInviteSentence(invite: Pick<TeamInvite, 'storeName' | 'role'>): string {
  return `${invite.storeName} invited you to join their team as ${invite.role === 'MANAGER' ? 'a manager' : 'staff'}.`;
}

export function useTeamInvites() {
  return useQuery<TeamInvite[]>({
    queryKey: teamInviteKeys.mine,
    queryFn: async () => (await unwrap<TeamInvite[]>(customerApi.teamInvites())) ?? [],
  });
}

export function useAnswerTeamInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'ACCEPT' | 'DECLINE' }) =>
      unwrap<{ decision: 'ACCEPTED' | 'DECLINED'; storeName?: string; role?: 'MANAGER' | 'STAFF' }>(
        decision === 'ACCEPT' ? customerApi.acceptTeamInvite(id) : customerApi.declineTeamInvite(id),
      ),
    // Answered either way (or already answered elsewhere): the card must go.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: teamInviteKeys.mine });
      void qc.invalidateQueries({ queryKey: ['customer', 'notifications'] });
    },
  });
}
