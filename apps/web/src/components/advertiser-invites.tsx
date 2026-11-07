'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { answerTeamInvite, getTeamInvites, type TeamInvite } from '@/lib/partner-api';
import { ApiRequestError } from '@/lib/auth';
import { DataUnavailable } from './data-unavailable';

// [ADS-ON · owner ruling, 3 Nov] Advertiser team invitations are answered here, on the website, so they need
// no new app build. The card says what the notice said: the company and the role. Nothing is granted until
// Accept; Decline removes the invitation.

const ROLE_WORDS: Record<string, string> = { MANAGER: 'a manager', ANALYST: 'an analyst' };

function InviteCard({ invite, onGone }: { invite: TeamInvite; onGone: (_message: string) => void }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const answer = useMutation({
    mutationFn: (choice: 'accept' | 'decline') => answerTeamInvite(invite.advertiserId, choice),
    onMutate: () => setFailed(false),
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 404) {
        onGone('This invitation is no longer open. Ask the company to send a new one.');
        void queryClient.invalidateQueries({ queryKey: ['ads-invites'] });
      } else setFailed(true);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ads-invites'] });
      void queryClient.invalidateQueries({ queryKey: ['ads-memberships'] });
    },
  });
  return (
    <div role="group" aria-label={`Team invitation from ${invite.companyName}`} className="sw-card p-5">
      <p className="sw-label">{invite.companyName} invited you to join their advertiser team as {ROLE_WORDS[invite.role] ?? 'a team member'}.</p>
      <p className="sw-caption mt-1">Nothing changes unless you accept.</p>
      {failed && <p role="alert" className="sw-caption mt-2">That did not go through. Nothing changed. Try again.</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="sw-btn sw-btn-md" disabled={answer.isPending} onClick={() => answer.mutate('accept')}>Accept</button>
        <button type="button" className="sw-link-btn" disabled={answer.isPending} onClick={() => answer.mutate('decline')}>Decline</button>
      </div>
    </div>
  );
}

export function AdvertiserInvites() {
  const q = useQuery({ queryKey: ['ads-invites'], queryFn: getTeamInvites });
  const [gone, setGone] = useState<string | null>(null);
  // The page says Swift Ads is not open: an invitation has nothing to add to that.
  if (q.error instanceof ApiRequestError && q.error.code === 'ADS_DISABLED') return null;
  return (
    <>
      {gone && <p role="alert" className="sw-caption">{gone}</p>}
      {q.isError && <DataUnavailable what="your team invitations" error={q.error} onRetry={() => void q.refetch()} />}
      {q.data?.map((invite) => <InviteCard key={invite.advertiserId} invite={invite} onGone={setGone} />)}
    </>
  );
}
