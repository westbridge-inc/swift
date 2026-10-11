/** @jsxImportSource react */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { weeklyFeeApi } from '../../../services/api';
import { getAuthSessionSnapshot, useAuthStore } from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { checkoutReferences, checkoutWords, dueLine, feeDate, feeExpiry, feeMoney, FeeCheckoutSession, liveMmg, REOPEN_ALREADY_PAID, reopenableMmg, subscriptionWords, type CheckoutView, type FeeFamily, type FeeSubscription } from '../../../lib/weeklyFee';
import { liveCard } from '../../../lib/cardFee';
import { CardPaySection, cardContextKey, hasCardSession } from '../components/CardPaySection';

export function WeeklyFeeScreen({ family, sub, loading, error, refresh, checkoutRef, contextPending = false }: {
  family: FeeFamily; sub?: FeeSubscription | null; loading?: boolean; error?: boolean;
  refresh: () => unknown; checkoutRef?: string; contextPending?: boolean;
}) {
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const resolvingStore = useStoreSwitcher((s) => s.feeContextPending);
  const contextError = useStoreSwitcher((s) => s.feeContextError);
  contextPending = contextPending || resolvingStore;
  const principal = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore((s) => s.sessionGeneration);
  const [view, setView] = useState<CheckoutView>({ checkout: null, busy: false, returned: false, error: '', blocked: false });
  // A card Pay now that may still take money hides the MMG button too: one payment at a time.
  const [cardPending, setCardPending] = useState(false);
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
  useEffect(() => { if (!contextPending) session.focus(sub?.latestMmgCheckout, checkoutRef); }, [session, sub?.latestMmgCheckout?.ref, checkoutRef, contextPending]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!contextPending) session.reconcile(sub?.latestMmgCheckout, sub?.recentCheckouts); }, [session, sub?.latestMmgCheckout, sub?.recentCheckouts, contextPending]);
  useFocusEffect(useCallback(() => { if (!contextPending) { void refreshRef.current(); session.focus(); } }, [session, contextPending]));
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !contextPending) { void refreshRef.current(); session.focus(); }
    });
    return () => listener.remove();
  }, [session, contextPending]);
  useEffect(() => {
    const timer = setInterval(() => { void refreshRef.current(); }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const pull = usePullToRefresh(async () => { await refreshRef.current(); if (!contextPending) session.focus(undefined, checkoutRef); });
  const action = liveMmg(sub);
  const checkout = view.returned ? view.checkout : view.checkout ?? sub?.latestMmgCheckout;
  const reopen = reopenableMmg(sub, checkout);
  const mmgPending = contextPending || view.blocked || checkout?.status === 'OPEN' || checkout?.status === 'EXPIRED' || checkout?.status === 'CONFIRMING' || checkout?.status === 'HELD';
  const canReopen = !!reopen && !contextPending && !view.blocked && !cardPending;
  const blocked = mmgPending || cardPending;
  const reopenExpiresAt = sub?.reopenableMmgCheckout?.expiresAt;
  const [, setExpiryTick] = useState(0);
  useEffect(() => {
    if (!reopenExpiresAt) return;
    const delay = Date.parse(reopenExpiresAt) - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(() => { setExpiryTick(Date.now()); void refreshRef.current(); }, Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [reopenExpiresAt]);
  // The card choice exists only when the server says CARD is live (or a card payment of ours is in flight).
  const card = liveCard(sub?.payActions);
  const showCard = !!card || cardPending || hasCardSession(cardContextKey(principal, generation, family, storeId));
  return <Screen>
    <Header title="Weekly fee" />
    {contextError ? <Card>
      <T variant="body">Couldn&apos;t open the notified store&apos;s weekly fee.</T>
      <PillButton label="Retry" onPress={() => { void contextError.retry(); }} />
      <PillButton label="Cancel" variant="soft" onPress={contextError.cancel} />
    </Card> : null}
    {loading ? <LoadingBlock /> : error || !sub ? <ErrorState message="We couldn't load your weekly fee. Try again." onRetry={() => { void refresh(); }} /> :
      <ScrollView refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />} contentContainerStyle={{ padding: space['2xl'], gap: space.lg }}>
        <Card>
          <T variant="heading">{dueLine(sub)}</T>
          <T variant="body" style={{ marginTop: space.md }}>{subscriptionWords(checkout?.subscriptionStatus ?? sub.status)}</T>
          {checkout ? <T variant="body" style={{ marginTop: space.md }}>{checkoutWords(checkout, view.returned)}</T> : null}
          {view.returned && !checkout ? <T variant="body">Waiting for MMG…</T> : null}
          {view.error ? <T variant="caption" tone="error" style={{ marginTop: space.md }}>{view.error}</T> : null}
          <PillButton label="Refresh status" variant="soft" style={{ marginTop: space.lg }} onPress={() => { void refresh(); if (!contextPending) session.focus(undefined, checkoutRef); }} />
        </Card>
        {action && !blocked && card ? <T variant="heading" accessibilityRole="header">Choose how to pay</T> : null}
        {canReopen && reopen ? <Card>
          <T variant="heading">Back to MMG&apos;s page</T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{feeExpiry(reopen.expiresAt)}</T>
          <T variant="body" style={{ marginTop: space.md }}>{REOPEN_ALREADY_PAID}</T>
          <PillButton label="Back to MMG's page" loading={view.busy} style={{ marginTop: space.lg }} onPress={() => { void session.reopen(reopen.ref); }} />
        </Card> : null}
        {action && !blocked ? <Card>
          <T variant="heading">Pay with MMG</T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>Opens MMG&apos;s page, then brings you back to Swift.</T>
          <PillButton label={`Pay ${feeMoney(action.amountGyd)} with MMG`} loading={view.busy} style={{ marginTop: space.lg }} onPress={() => { void session.pay(); }} />
        </Card> : null}
        {showCard ? <CardPaySection family={family} card={card} contextPending={contextPending} otherPaymentPending={mmgPending} refresh={refresh} onPaymentPending={setCardPending} /> : null}
        <T variant="caption">The weekly fee is Swift&apos;s only charge, so you keep 100% of everything you earn.</T>
        <View>
          <T variant="heading">Recent checkouts</T>
          {sub.recentCheckouts?.length ? sub.recentCheckouts.map((c) => {
            const shown = c.ref === view.checkout?.ref ? view.checkout : c;
            return <Card key={c.ref} style={{ marginTop: space.md }}>
              <T variant="caption" tone="muted">{feeDate(c.createdAt)} · {feeMoney(c.amountGyd)}</T>
              <T variant="body">{checkoutWords(shown, c.ref === view.checkout?.ref && view.returned)}</T>
              {/* The references support finds this payment by: ours always, MMG's once confirmed. */}
              {checkoutReferences(shown).map((r) => <T key={r.label} variant="caption" tone="muted" selectable>{r.label}: {r.value}</T>)}
            </Card>;
          }) : <T variant="caption" tone="muted" style={{ marginTop: space.md }}>No recent checkouts.</T>}
        </View>
      </ScrollView>}
  </Screen>;
}
