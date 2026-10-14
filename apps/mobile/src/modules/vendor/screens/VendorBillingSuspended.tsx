/** @jsxImportSource react */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { color, radius, space } from '@swift/ui';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Card, Chip, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { GUTTER } from '../shared';
import { useVendorSubscription } from '../../../hooks/vendorops';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { type VendorMemberRole, TabHeader, VendorBillingNotice } from '../shared';
import { HeldStoreOrders } from './HeldStoreOrders';

export function VendorBillingSuspended({ store, stores, myRole }: { store: any; stores: any[]; myRole?: VendorMemberRole }) {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const setSelectedStore = useStoreSwitcher((state) => state.setSelectedStore);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const isOwner = myRole === 'OWNER';
  const subQ = useVendorSubscription(isOwner);
  // Spinner on the owner's own pull or store switch, never on a background
  // refetch (lib/pullToRefresh).
  const pull = usePullToRefresh(() => Promise.all([
    isOwner ? subQ.refetch() : undefined,
    qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }),
    // The accepted orders listed below reload with the pull too.
    qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  ]));
  const sub = subQ.data ?? (isOwner ? store?.subscription : null);
  const blockedSub = ['SUSPENDED', 'CHURNED'].includes(String(sub?.status ?? '').toUpperCase());
  const switchStore = (id: string) => setSelectedStore(id);

  return (
    <Screen>
      {/* A paused store pauses selling, not the person: Swift stays one tap away. */}
      <TabHeader title={store.name} eyebrow="ACCOUNT PAUSED · ORDERS OFF" statusTone="warning" onSwitch={() => setSwitcherOpen(true)} />
      <RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={() => { void pull.onRefresh(); }}
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
              ? 'The weekly fee needs attention. Open Weekly fee to view your checkout; a credited payment clears the billing hold. Orders you already accepted can still be finished below. Any separate verification hold still needs its own fix.'
              : 'The store’s weekly fee needs attention. Ask the owner to open Weekly fee; only the owner can access billing. Orders already accepted can still be finished below.'}
          </T>
        </View>

        {isOwner && subQ.isLoading && !sub ? (
          <LoadingBlock />
        ) : isOwner && blockedSub ? (
          <>
            {subQ.isError ? (
              <T variant="caption" tone="muted" center style={{ marginBottom: space.sm }}>
                Showing the last loaded billing status — pull to retry.
              </T>
            ) : null}
            <VendorBillingNotice sub={sub} onPay={() => navigation.navigate('WeeklyFee')} />
          </>
        ) : isOwner ? (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Billing details are unavailable
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              The store is still paused. Open Weekly fee to check your payment; pull down to retry this status.
            </T>
            <PillButton
              label="Weekly fee"
              icon="hash"
              size="md"
              style={{ marginTop: space.md }}
              onPress={() => navigation.navigate('WeeklyFee')}
            />
          </Card>
        ) : (
          <Card style={{ marginBottom: space.lg }}>
            <T variant="label" weight="semibold">
              Owner action required
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              New orders come back when the owner’s payment is confirmed and the store is active again. Until then, finish the orders already accepted.
            </T>
          </Card>
        )}

        {/* [NO-DEAD-ENDS · owner ruling 1 Oct] Accepted orders are completed;
            new ones wait to be declined. The server allows exactly this. */}
        <HeldStoreOrders canFinishAccepted navigation={navigation} />

        <T variant="caption" tone="muted" center>
          Swift never takes commission. The weekly fee is separate from customer order money.
        </T>
      </ScrollView>
    </Screen>
  );
}
