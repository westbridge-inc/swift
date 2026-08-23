/** @jsxImportSource react */
import React from 'react';
import { Share, View } from 'react-native';
import { color, space } from '@swift/ui';
import { useProfile } from '../../../hooks/customer';
import { Card, ErrorState, Header, IconChip, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { toast } from '../../../components/ui/toast';

const GUTTER = space['2xl'];

// Kit Invite Friends (53) on the real referral system: the customer's
// referralCode is shareable; friends redeem it at signup.
export function InviteFriendsScreen() {
  const profile = useProfile<any>();
  const p = profile.data;
  const code: string | undefined = p?.customer?.referralCode;
  const referred: number = p?.customer?.referredCount ?? 0;

  if (profile.isLoading) return <LoadingBlock style={{ backgroundColor: color.surface.subtle }} />;
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
      message: `Join me on Swift — food, groceries, taxis and more, cash on delivery. Use my code ${code} when you sign up!`,
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
            Share your code — friends attach it at signup and you both build trust faster.
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

        <View style={{ flex: 1 }} />
        <PillButton label="Share My Code" icon="share-2" onPress={share} disabled={!code} style={{ marginBottom: space['2xl'] }} />
      </View>
    </Screen>
  );
}
