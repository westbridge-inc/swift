/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { Card, LabeledInput, LoadingBlock, PillButton, T, TonePill } from '../../../kit';
import { useMyAdvertisers, useAdvertiserMembers, useAdvertiserActions } from '../../../hooks/advertiser';
import { useAuthStore } from '../../../stores/authStore';
import { errorMessage } from '../../../lib/apiError';

// §14.6 — team. OWNER invites MANAGER (runs campaigns) / ANALYST (reads
// stats) by phone; the invitee must already hold a Swift account. The server
// is the authority — a non-owner sees the list, and the add box simply isn't
// rendered for them.

export function AdvertiserTeamScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuthStore();
  const me = useMyAdvertisers();
  const advertiser = (me.data ?? [])[0];
  const members = useAdvertiserMembers(advertiser?.id);
  const actions = useAdvertiserActions(advertiser?.id);
  const [phone, setPhone] = useState('+592');
  const [role, setRole] = useState<'MANAGER' | 'ANALYST'>('MANAGER');
  const [error, setError] = useState<string | null>(null);

  const rows = members.data ?? [];
  const myRole = rows.find((m: any) => m.userId === (user as any)?.id)?.role;
  const isOwner = myRole === 'OWNER';

  const add = () => {
    setError(null);
    actions.addMember.mutate(
      { phone: phone.trim(), role },
      {
        onSuccess: () => setPhone('+592'),
        onError: (e) => setError(errorMessage(e, 'Could not add that person — they need a Swift account first.')),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
      <T variant="title" style={{ paddingHorizontal: space['2xl'], paddingTop: space.lg }}>
        Team
      </T>
      <ScrollView contentContainerStyle={{ padding: space['2xl'], paddingBottom: space['3xl'] }} keyboardShouldPersistTaps="handled">
        {members.isLoading ? (
          <LoadingBlock style={{ paddingTop: 64 }} />
        ) : (
          <View style={{ gap: space.md }}>
            {rows.map((m: any) => (
              <Card key={m.userId} style={{ padding: space.xl, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1, marginRight: space.md }}>
                  <T variant="body" weight="semibold" numberOfLines={1}>
                    {m.name || m.phone || 'Member'}
                  </T>
                  {m.phone ? (
                    <T variant="caption" tone="muted">
                      {m.phone}
                    </T>
                  ) : null}
                </View>
                <TonePill label={m.role} tone={m.role === 'OWNER' ? 'brand' : 'neutral'} />
              </Card>
            ))}
          </View>
        )}

        {isOwner ? (
          <Card style={{ padding: space.xl, marginTop: space['2xl'], gap: space.lg }}>
            <T variant="label" weight="semibold">
              Add a team member
            </T>
            <LabeledInput label="Their Swift phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+5926001234" />
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <PillButton label="Manager" size="sm" variant={role === 'MANAGER' ? 'primary' : 'soft'} onPress={() => setRole('MANAGER')} />
              <PillButton label="Analyst" size="sm" variant={role === 'ANALYST' ? 'primary' : 'soft'} onPress={() => setRole('ANALYST')} />
            </View>
            <T variant="caption" tone="muted">
              Managers run campaigns and creatives; analysts see stats and invoices. Only the owner books and pays.
            </T>
            {error ? (
              <T variant="label" style={{ color: color.error }}>
                {error}
              </T>
            ) : null}
            <PillButton label="Add member" loading={actions.addMember.isPending} onPress={add} />
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}
