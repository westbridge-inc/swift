/** @jsxImportSource react */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { chainFeeApi } from '../../../services/api';
import { getAuthSessionSnapshot, useAuthStore } from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorProfile } from '../../../hooks/vendorops';
import { useStepUp } from '../../../hooks/useStepUp';
import { usePullToRefresh } from '../../../hooks/usePullToRefresh';
import { isStepUpDismissed } from '../../../lib/stepUp';
import { feeDate, feeMoney } from '../../../lib/fee-status';
import {
  CHAIN_COPY, ChainCheckoutSession, branchCount, chainBranchWords, chainCheckoutReferences, chainCheckoutWords, chainConfirmed, chainShares,
  chainUnsettled, dueBranches, type ChainFees, type ChainView,
} from '../../../lib/chain-fee';

/**
 * [ENTERPRISE E1b · owner 29 Oct 2026] "Pay all my branches" (MMG-CHECKOUT-API.md section 12): the business owner sees
 * each branch with what its own Pay would charge now, the server's total, and pays every branch that is due in ONE
 * MMG checkout after "Confirm it's you". The checkout is followed exactly as one branch's fee screen follows its own
 * (the same polling, the same words); nothing is called paid until the server says MMG confirmed it. Reached from the
 * owner's Weekly fee screen, and from a pay-all payment's notice (WeeklyFee route with payAll). A manager or staff
 * member is never offered it: here they are told so, and nothing is asked of the server (which refuses them anyway).
 */
export function VendorPayAllScreen({ checkoutRef }: { checkoutRef?: string }) {
  const { myRole, state, refetch } = useVendorProfile();
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  return <Screen>
    <Header title={CHAIN_COPY.title} />
    {myRole === 'OWNER'
      ? <VendorPayAll key={storeId ?? 'no-store'} storeId={storeId} checkoutRef={checkoutRef} />
      : state === 'loading' ? <LoadingBlock />
        : state === 'error' ? <ErrorState message="We couldn't load your store details. Try again." onRetry={refetch} />
          : <Card style={{ margin: space['2xl'] }}><T variant="body">{CHAIN_COPY.ownerOnly}</T></Card>}
  </Screen>;
}

export function VendorPayAll({ storeId, checkoutRef }: { storeId: string | null; checkoutRef?: string }) {
  const principal = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore((s) => s.sessionGeneration);
  const client = useMemo(() => {
    const owner = getAuthSessionSnapshot();
    return chainFeeApi(owner?.userId === principal && owner?.generation === generation ? owner : null, storeId);
  }, [principal, generation, storeId]);
  const q = useQuery<ChainFees>({ queryKey: ['vendor', 'chain-fees', storeId, principal, generation], queryFn: () => client.list(), staleTime: 0 });
  const refreshRef = React.useRef(q.refetch); refreshRef.current = q.refetch;
  const { withStepUp, sheet: stepUpSheet } = useStepUp();
  const [view, setView] = useState<ChainView>({ checkout: null, busy: false, returned: false, error: '', blocked: false });
  const session = useMemo(() => new ChainCheckoutSession({
    // One MMG page for several fees: the server asks for a fresh "Confirm it's you" first (403 STEP_UP_REQUIRED).
    start: withStepUp(client.start),
    read: client.read,
    open: (url) => WebBrowser.openAuthSessionAsync(url, 'swift://pay/mmg/return'),
    refresh: () => { void refreshRef.current(); },
  }, () => Crypto.randomUUID(), setView, (e) => {
    if (isStepUpDismissed(e)) return { dismissed: true };
    const failure = e as { response?: { status?: number; data?: { error?: { code?: string; details?: { ref?: string } } } } };
    return { status: failure.response?.status, ...failure.response?.data?.error };
  }), [client, withStepUp]);
  const latest = q.data?.recentCheckouts?.[0];
  useEffect(() => { session.activate(); return () => session.dispose(); }, [session]);
  useEffect(() => { session.focus(latest, checkoutRef); }, [session, latest?.ref, checkoutRef]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { session.reconcile(q.data?.recentCheckouts); }, [session, q.data?.recentCheckouts]);
  useFocusEffect(useCallback(() => { void refreshRef.current(); session.focus(); }, [session]));
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') { void refreshRef.current(); session.focus(); } });
    return () => listener.remove();
  }, [session]);
  const pull = usePullToRefresh(async () => { await refreshRef.current(); session.focus(undefined, checkoutRef); });

  if (q.isLoading) return <LoadingBlock />;
  if (q.isError || !q.data) return <ErrorState message="We couldn't load your branches' weekly fees. Try again." onRetry={() => { void q.refetch(); }} />;
  const fees = q.data;
  const due = dueBranches(fees);
  const confirmed = chainConfirmed(fees);
  const checkout = view.returned ? view.checkout : view.checkout ?? latest ?? null;
  const pending = view.blocked || chainUnsettled(checkout);
  return <ScrollView refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />} contentContainerStyle={{ padding: space['2xl'], gap: space.lg }}>
    <Card>
      <T variant="body" weight="semibold">{CHAIN_COPY.intro}</T>
      <T variant="body" style={{ marginTop: space.md }}>{CHAIN_COPY.optional}</T>
      <T variant="caption" tone="muted" style={{ marginTop: space.md }}>{CHAIN_COPY.notCharged}</T>
    </Card>
    <Card testID="pay-all-branches">
      {fees.branches.map((b) => <View key={b.vendorId} style={{ paddingVertical: space.sm }}>
        <T variant="label" weight="semibold">{b.branchName}</T>
        <T variant={b.state === 'DUE' ? 'body' : 'caption'} tone={b.state === 'DUE' ? undefined : 'muted'}>{chainBranchWords(b)}</T>
      </View>)}
    </Card>
    <Card>
      {due.length > 0
        ? <T variant="heading" testID="pay-all-total">{`Total due: ${feeMoney(fees.totalGyd)} for ${branchCount(due.length)}`}</T>
        : <T variant="heading">{CHAIN_COPY.nothingDue}</T>}
      {checkout ? <T variant="body" style={{ marginTop: space.md }}>{chainCheckoutWords(checkout, view.returned)}</T> : null}
      {view.returned && !checkout ? <T variant="body">Waiting for MMG…</T> : null}
      {checkout && chainUnsettled(checkout) ? <T variant="caption" tone="muted" style={{ marginTop: space.md }}>{CHAIN_COPY.paused}</T> : null}
      {view.error ? <T variant="caption" tone="error" style={{ marginTop: space.md }}>{view.error}</T> : null}
      {due.length > 0 && !fees.payable ? <T variant="caption" tone="muted" style={{ marginTop: space.md }}>{CHAIN_COPY.notHere}</T> : null}
      {confirmed && !pending ? <>
        <T variant="caption" tone="muted" style={{ marginTop: space.md }}>{`Opens MMG's page, then brings you back to Swift. ${CHAIN_COPY.confirmFirst}`}</T>
        <PillButton label={`Pay ${feeMoney(confirmed.totalGyd)} with MMG`} loading={view.busy} style={{ marginTop: space.lg }} onPress={() => { void session.pay(confirmed); }} />
      </> : null}
    </Card>
    <View>
      <T variant="heading">{CHAIN_COPY.recent}</T>
      {fees.recentCheckouts?.length ? fees.recentCheckouts.map((c) => {
        const shown = c.ref === view.checkout?.ref ? view.checkout : c;
        return <Card key={c.ref} style={{ marginTop: space.md }}>
          <T variant="caption" tone="muted">{`${feeDate(c.createdAt)} · ${feeMoney(c.amountGyd)} · ${branchCount(shown.branches?.length ?? 0)}`}</T>
          <T variant="body">{chainCheckoutWords(shown, c.ref === view.checkout?.ref && view.returned)}</T>
          {chainShares(shown).map((line, i) => <T key={i} variant="caption">{line}</T>)}
          {/* The references support finds this payment by: ours always, MMG's once confirmed. */}
          {chainCheckoutReferences(shown).map((r) => <T key={r.label} variant="caption" tone="muted" selectable>{`${r.label}: ${r.value}`}</T>)}
        </Card>;
      }) : <T variant="caption" tone="muted" style={{ marginTop: space.md }}>{CHAIN_COPY.noRecent}</T>}
    </View>
    {stepUpSheet}
  </ScrollView>;
}
