/** @jsxImportSource react */
import React, { useState } from 'react';
import { Share, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { useProfile } from '../../../hooks/customer';
import { Card, ErrorState, Header, IconChip, LabeledInput, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { toast } from '../../../kit/toast';
import { serverMessage } from '../../../lib/stepUp';
import { customerApi } from '../../../services/api';

const GUTTER = space['2xl'];

// Kit Invite Friends (53) on the real referral system: the customer's
// referralCode is shareable. [BUG-HUNT F13] No sign-up form, web or phone, has a
// code field, so "attach it at signup" was a promise nobody could keep. A friend
// enters it here, after they join (POST /customer/referral/redeem).
export function InviteFriendsScreen() {
  const profile = useProfile<any>();
  const p = profile.data;
  const code: string | undefined = p?.customer?.referralCode;
  const referred: number = p?.customer?.referredCount ?? 0;
  const alreadyUsed = !!p?.customer?.referredBy;
  const [friendCode, setFriendCode] = useState('');
  const redeem = useMutation({
    mutationFn: () => customerApi.redeemReferral(friendCode.trim()),
    onSuccess: () => { setFriendCode(''); toast.show('Your friend’s code is saved.'); void profile.refetch(); },
    onError: (error) => toast.show(serverMessage(error, 'That code didn’t go through. Check it and try again.')),
  });

  if (profile.isLoading) {
    return (
      <Screen>
        <Header title="Invite Friends" />
        <LoadingBlock />
      </Screen>
    );
  }
  if (profile.isError || !p) {
    return (
      <Screen>
        <Header title="Invite Friends" />
        <ErrorState onRetry={() => profile.refetch()} />
      </Screen>
    );
  }

  const share = () =>
    void Share.share({
      message: `Join me on Swift — food, groceries, taxis and more, cash on delivery. After you sign up, open Invite Friends and enter my code ${code}.`,
    }).catch(() => toast.show("Couldn't open the share sheet."));

  return (
    <Screen>
      <Header title="Invite Friends" />
      <View style={{ flex: 1, paddingHorizontal: GUTTER, paddingTop: space.xl }}>
        <View style={{ alignItems: 'center' }}>
          <IconChip icon="gift" size={88} />
          <T variant="title" center style={{ marginTop: space.xl }}>
            Bring your people
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm, maxWidth: 300 }}>
            Share your code. A friend enters it here after they join, and you can see how many joined.
          </T>
        </View>

        <Card style={{ alignItems: 'center', marginTop: space['2xl'] }}>
          <T variant="label" tone="muted">
            Your code
          </T>
          <T variant="display" tone="brand" style={{ marginTop: space.sm, letterSpacing: 2 }}>
            {code ?? '—'}
          </T>
          <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
            {referred} friend{referred === 1 ? '' : 's'} joined with your code
          </T>
        </Card>

        {alreadyUsed ? null : (
          <Card style={{ marginTop: space.lg, gap: space.sm }}>
            <LabeledInput label="Have a friend’s code?" value={friendCode} onChangeText={setFriendCode} autoCapitalize="characters" autoCorrect={false} />
            <PillButton label="Enter code" onPress={() => redeem.mutate()} disabled={!friendCode.trim() || redeem.isPending} size="md" />
          </Card>
        )}

        <View style={{ flex: 1 }} />
        <PillButton label="Share My Code" icon="share-2" onPress={share} disabled={!code} style={{ marginBottom: space['2xl'] }} />
      </View>
    </Screen>
  );
}
