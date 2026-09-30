/** @jsxImportSource react */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { weeklyFeeApi } from '../../../services/api';
import { getAuthSessionSnapshot, useAuthStore } from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { checkoutWords, dueLine, feeDate, feeMoney, FeeCheckoutSession, liveMmg, subscriptionWords, type CheckoutView, type FeeFamily, type FeeSubscription } from '../../../lib/weeklyFee';

export function WeeklyFeeScreen({ family, sub, loading, error, refresh, checkoutRef }: {
  family: FeeFamily; sub?: FeeSubscription | null; loading?: boolean; error?: boolean;
  refresh: () => unknown; checkoutRef?: string;
}) {
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const principal = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore((s) => s.sessionGeneration);
  const [view, setView] = useState<CheckoutView>({ checkout: null, busy: false, returned: false, error: '', blocked: false });
  const refreshRef = React.useRef(refresh); refreshRef.current = refresh;
  const session = useMemo(() => {
    const owner = getAuthSessionSnapshot();
    const client = weeklyFeeApi(family, owner?.userId === principal && owner?.generation === generation ? owner : null, storeId);
    return new FeeCheckoutSession({
      ...client,
      open: (url) => WebBrowser.openAuthSessionAsync(url, 'swift://pay/mmg/return'),
      refresh: () => { void refreshRef.current(); },
    }, () => Crypto.randomUUID(), setView, (e) => {
      const failure = e as { response?: { status?: number; data?: { error?: { code?: string; details?: { ref?: string } } } } };
      return { status: failure.response?.status, ...failure.response?.data?.error };
    });
  }, [family, storeId, principal, generation]);
  useEffect(() => { session.activate(); return () => session.dispose(); }, [session]);
  useEffect(() => { session.focus(sub?.latestMmgCheckout, checkoutRef); }, [session, sub?.latestMmgCheckout?.ref, checkoutRef]); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusEffect(useCallback(() => { void refreshRef.current(); session.focus(); }, [session]));
  useEffect(() => {
    const timer = setInterval(() => { void refreshRef.current(); }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const pull = usePullToRefresh(async () => { await refreshRef.current(); session.focus(undefined, checkoutRef); });
  const action = liveMmg(sub);
  const checkout = view.returned ? view.checkout : view.checkout ?? sub?.latestMmgCheckout;
  const blocked = view.blocked || checkout?.status === 'CONFIRMING' || checkout?.status === 'HELD';
  return <Screen>
    <Header title="Weekly fee" />
    {loading ? <LoadingBlock /> : error || !sub ? <ErrorState message="We couldn't load your weekly fee. Try again." onRetry={() => { void refresh(); }} /> :
      <ScrollView refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />} contentContainerStyle={{ padding: space['2xl'], gap: space.lg }}>
        <Card>
          <T variant="heading">{dueLine(sub)}</T>
          <T variant="body" style={{ marginTop: space.md }}>{subscriptionWords(checkout?.subscriptionStatus ?? sub.status)}</T>
          {checkout ? <T variant="body" style={{ marginTop: space.md }}>{checkoutWords(checkout, view.returned)}</T> : null}
          {view.returned && !checkout ? <T variant="body">Waiting for MMG…</T> : null}
          {view.error ? <T variant="caption" tone="error" style={{ marginTop: space.md }}>{view.error}</T> : null}
          {action && !blocked ? <PillButton label={`Pay ${feeMoney(action.amountGyd)} with MMG`} loading={view.busy} style={{ marginTop: space.lg }} onPress={() => { void session.pay(); }} /> : null}
          <PillButton label="Refresh status" variant="soft" style={{ marginTop: space.md }} onPress={() => { void refresh(); session.focus(undefined, checkoutRef); }} />
        </Card>
        <T variant="caption">The weekly fee is Swift&apos;s only charge, so you keep 100% of everything you earn.</T>
        <View>
          <T variant="heading">Recent checkouts</T>
          {sub.recentCheckouts?.length ? sub.recentCheckouts.map((c) => <Card key={c.ref} style={{ marginTop: space.md }}>
            <T variant="caption" tone="muted">{feeDate(c.createdAt)} · {feeMoney(c.amountGyd)}</T>
            <T variant="body">{checkoutWords(c.ref === view.checkout?.ref ? view.checkout : c, c.ref === view.checkout?.ref && view.returned)}</T>
          </Card>) : <T variant="caption" tone="muted" style={{ marginTop: space.md }}>No recent checkouts.</T>}
        </View>
      </ScrollView>}
  </Screen>;
}
