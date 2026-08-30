/** @jsxImportSource react */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Card, Chip, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { GUTTER } from '../shared';
import { disconnectSocket } from '../../../services/socket';
import { useVendorSubscription } from '../../../hooks/vendorops';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { type VendorMemberRole, TabHeader, VendorBillingNotice } from '../shared';

export function VendorBillingSuspended({ store, stores, myRole }: { store: any; stores: any[]; myRole?: VendorMemberRole }) {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const setSelectedStore = useStoreSwitcher((state) => state.setSelectedStore);
  const [switchingStore, setSwitchingStore] = useState(false);
  const isOwner = myRole === 'OWNER';
  const subQ = useVendorSubscription(isOwner);
  const sub = subQ.data ?? (isOwner ? store?.subscription : null);
  const blockedSub = ['SUSPENDED', 'CHURNED'].includes(String(sub?.status ?? '').toUpperCase());
  const switchStore = async (id: string) => {
    if (id === store.id || switchingStore) return;
    setSwitchingStore(true);
    disconnectSocket();
    setSelectedStore(id);
    try {
      await Promise.all([
        qc.resetQueries({ queryKey: ['vendor'] }),
        qc.resetQueries({ queryKey: ['verification'] }),
      ]);
    } finally {
      setSwitchingStore(false);
    }
  };

  return (
    <Screen>
      <TabHeader title={store.name} eyebrow="ACCOUNT PAUSED · ORDERS OFF" statusTone="warning" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={switchingStore || subQ.isRefetching}
            onRefresh={() => {
              if (isOwner) subQ.refetch();
              void qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
            }}
            tintColor={color.brand[500]}
          />
        }
      >
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, marginBottom: space.lg }}>
            {stores.map((candidate) => (
              <Chip
                key={candidate.id}
                label={candidate.name}
                selected={candidate.id === store.id}
                onPress={() => void switchStore(candidate.id)}
              />
            ))}
          </ScrollView>
        ) : null}

        <View style={{ alignItems: 'center', paddingHorizontal: space.lg, marginBottom: space.lg }}>
          <View
            style={{
              width: space['5xl'] + space.lg,
              height: space['5xl'] + space.lg,
              borderRadius: radius.full,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.soft.warning,
            }}
          >
            <MaterialCommunityIcons name="store-alert-outline" size={30} color={color.warning} />
          </View>
          <T variant="title" center style={{ marginTop: space.lg }}>
            New orders are paused
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            {isOwner
              ? 'The weekly fee needs attention. Pay with the store’s Swift Number; confirmation clears the billing hold. Any separate verification hold still needs its own fix.'
              : 'The store’s weekly fee needs attention. Ask the owner to pay with the store’s Swift Number; only the owner can access billing.'}
          </T>
        </View>

        {switchingStore || (isOwner && subQ.isLoading && !sub) ? (
          <LoadingBlock />
        ) : isOwner && blockedSub ? (
          <>
            {subQ.isError ? (
              <T variant="caption" tone="muted" center style={{ marginBottom: space.sm }}>
                Showing the last loaded billing status — pull to retry.
              </T>
            ) : null}
            <VendorBillingNotice sub={sub} onPay={() => navigation.navigate('VendorMySwiftNumber')} />
          </>
        ) : isOwner ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Billing details are unavailable
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              The store is still paused. Use your Swift Number to check the cash/MMG payment steps; pull down to retry this status.
            </T>
            <PillButton
              label="How to pay"
              icon="hash"
              size="md"
              style={{ marginTop: space.md }}
              onPress={() => navigation.navigate('VendorMySwiftNumber')}
            />
          </Card>
        ) : (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Owner action required
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              You can return to the queue when the owner’s payment is confirmed and the store is active again.
            </T>
          </Card>
        )}

        <T variant="caption" tone="muted" center>
          Swift never takes commission. The weekly fee is separate from customer order money.
        </T>
      </ScrollView>
    </Screen>
  );
}
