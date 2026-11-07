/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { space } from '@swift/ui';
import { Card, SettingsRow, T } from '../../kit';
import { useActiveJob, useMoverKind, useMoverSubscription } from '../../hooks';

/**
 * [BUG-HUNT F10] A rider or driver whose document lapses or is revoked lands on the same screen as a new sign-up. The
 * job in their hands is still theirs to finish, and their fee and earnings are still theirs to see, and the sign-up
 * screen had no way to any of it. `approvedBefore`: the weekly fee is born on the first approval, so a fee on record
 * (or the older verified flag) is someone Swift has approved before, never a person signing up.
 */
export function useMoverPastSignUp() {
  const { kind, profile } = useMoverKind();
  const job = useActiveJob(kind).data as { id?: unknown } | null | undefined;
  const fee = useMoverSubscription(kind).data;
  const verifiedOnce = (profile as { documentsVerified?: unknown } | null | undefined)?.documentsVerified === true;
  return { job: job ?? null, approvedBefore: !!kind && (!!fee || verifiedOnce) };
}

export function MoverWorkDoors() {
  const navigation = useNavigation<any>();
  const { job, approvedBefore } = useMoverPastSignUp();
  if (!job && !approvedBefore) return null;
  return (
    <View style={{ gap: space.md, marginTop: space.lg }}>
      {job ? (
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate('ActiveJob')}>
          <Card style={{ gap: 4 }}>
            <T variant="body" weight="bold">You have a job in progress</T>
            <T variant="caption" tone="muted">It is still yours to finish. Tap to open it.</T>
          </Card>
        </Pressable>
      ) : null}
      {approvedBefore ? (
        <Card style={{ padding: 0 }}>
          <SettingsRow icon="dollar-sign" label="Earnings" onPress={() => navigation.navigate('Earnings')} />
          <SettingsRow icon="calendar" label="Weekly fee" onPress={() => navigation.navigate('WeeklyFee')} />
        </Card>
      ) : null}
    </View>
  );
}
