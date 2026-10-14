/** @jsxImportSource react */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Chip, PillButton, Screen, T } from '../../../kit';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { billingBlocked, type StoreHold } from '../../../lib/vendorProfile';
import { GUTTER, TabHeader, type VendorMemberRole } from '../shared';
import { HeldStoreOrders } from './HeldStoreOrders';

type BlockingHold = Exclude<StoreHold, 'FEE_UNPAID'>;

/** What each hold is, in plain words, and why paying does not lift it. */
export const STORE_HOLD_COPY: Record<BlockingHold, { eyebrow: string; title: string; body: string; helpSubject: string }> = {
  SUSPENDED_BY_SWIFT: {
    eyebrow: 'SUSPENDED BY SWIFT · ORDERS OFF',
    title: 'Swift has suspended this store',
    body: 'Orders are off while the store is suspended. Ask Swift support why, and what will restore it — a person answers. Paying the weekly fee does not lift this kind of hold.',
    helpSubject: 'Why was my store suspended?',
  },
  OWNER_ACCOUNT_CLOSED: {
    eyebrow: 'STORE CLOSED · ORDERS OFF',
    title: 'This store was closed',
    body: 'It closed when the owner’s Swift account was closed, so it can’t take or work orders. If that’s a mistake, ask Swift support.',
    helpSubject: 'My store was closed with an account',
  },
  SUSPENDED: {
    eyebrow: 'SUSPENDED · ORDERS OFF',
    title: 'This store is suspended',
    body: 'Orders are off while the store is suspended. Ask Swift support why, and what will restore it — a person answers.',
    helpSubject: 'Why is my store suspended?',
  },
  CLOSED: {
    eyebrow: 'STORE CLOSED · ORDERS OFF',
    title: 'This store is closed',
    body: 'A closed store can’t take or work orders. If it should be open, ask Swift support.',
    helpSubject: 'My store shows as closed',
  },
};

/**
 * [NO-DEAD-ENDS · owner, 6 Oct] A store Swift suspended, or one that was
 * closed, used to land on the onboarding checklist: a price card, every
 * document approved, and "selling unlocks the moment you're approved". No
 * reason, no door. This screen names the hold, opens a ticket to a person,
 * and keeps the open orders one tap away so they can be declined.
 */
export function VendorStoreBlocked({ store, stores, myRole, hold }: {
  store: any;
  stores: any[];
  myRole?: VendorMemberRole;
  hold: BlockingHold;
}) {
  const navigation = useNavigation<any>();
  const qc = useQueryClient();
  const setSelectedStore = useStoreSwitcher((state) => state.setSelectedStore);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const copy = STORE_HOLD_COPY[hold];
  const pull = usePullToRefresh(() => qc.invalidateQueries({ queryKey: ['vendor'] }));
  // A separate unpaid fee is still the owner's to settle; it just isn't what
  // reopens this store.
  const feeAlsoDue = myRole === 'OWNER' && billingBlocked({ subscription: store?.subscription });

  return (
    <Screen>
      <TabHeader title={store.name} eyebrow={copy.eyebrow} statusTone="warning" onSwitch={() => setSwitcherOpen(true)} />
      <RoleSwitcherSheet visible={switcherOpen} current="vendor" onClose={() => setSwitcherOpen(false)} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={pull.refreshing} onRefresh={() => { void pull.onRefresh(); }} tintColor={color.brand[500]} />
        }
      >
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, marginBottom: space.lg }}>
            {stores.map((candidate) => (
              <Chip key={candidate.id} label={candidate.name} selected={candidate.id === store.id} onPress={() => setSelectedStore(candidate.id)} />
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
            <MaterialCommunityIcons name="store-off-outline" size={30} color={color.warning} />
          </View>
          <T variant="title" center style={{ marginTop: space.lg }}>
            {copy.title}
          </T>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            {copy.body}
          </T>
        </View>

        <PillButton
          testID="store-hold-get-help"
          label="Ask Swift support"
          icon="life-buoy"
          style={{ marginBottom: space.md }}
          onPress={() => navigation.navigate('GetHelp', { category: 'VENDOR', subject: `${copy.helpSubject} (${store.name})` })}
        />
        {feeAlsoDue ? (
          <PillButton
            testID="store-hold-weekly-fee"
            label="Weekly fee"
            icon="hash"
            variant="soft"
            style={{ marginBottom: space.lg }}
            onPress={() => navigation.navigate('WeeklyFee')}
          />
        ) : null}

        <HeldStoreOrders canFinishAccepted={false} navigation={navigation} />
      </ScrollView>
    </Screen>
  );
}
