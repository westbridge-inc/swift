/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { Card, PillButton, T } from '../../../kit';
import { toast } from '../../../kit/toast';
import { teamInviteSentence, useAnswerTeamInvite, useTeamInvites, type TeamInvite } from '../../../hooks/teamInvites';

// [Row 55] A store team invite, answered here. Plain and honest: who invited
// you, as what, and two buttons. Nothing joins you to a team until Accept.

function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { error?: { message?: string } } } };
  return e?.response?.data?.error?.message ?? 'That didn’t go through. Try again.';
}

export function TeamInviteCards() {
  const invites = useTeamInvites();
  const answer = useAnswerTeamInvite();
  const rows: TeamInvite[] = Array.isArray(invites.data) ? invites.data : [];
  if (rows.length === 0) return null;

  const respond = (invite: TeamInvite, decision: 'ACCEPT' | 'DECLINE') =>
    answer.mutate(
      { id: invite.id, decision },
      {
        onSuccess: () => {
          if (decision === 'ACCEPT') {
            toast.success(`You joined ${invite.storeName}. Open Swift Business to start.`);
          } else {
            toast.success('Invite declined.');
          }
        },
        onError: (error: unknown) => toast.error(errorMessage(error)),
      },
    );

  return (
    <View style={{ paddingHorizontal: space['2xl'], paddingTop: space.md, gap: space.md }}>
      {rows.map((invite) => (
        <Card key={invite.id} style={{ padding: space.md, gap: space.sm }}>
          <T variant="body" weight="semibold">{teamInviteSentence(invite)}</T>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <PillButton
              label="Accept"
              size="md"
              disabled={answer.isPending}
              onPress={() => respond(invite, 'ACCEPT')}
            />
            <PillButton
              label="Decline"
              variant="outline"
              size="md"
              disabled={answer.isPending}
              onPress={() => respond(invite, 'DECLINE')}
            />
          </View>
        </Card>
      ))}
    </View>
  );
}
