/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { color, space } from '@swift/ui';
import { Card, Chip, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import {
  useAllBranchOrders, useBranchStores, useBranchesSummary, useCopyMenu, useVendorHours, useVendorProfile, type BranchStore,
} from '../../../hooks/vendorops';
import { vendorApi } from '../../../services/api';
import { moneyIn } from '../../../lib/money';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import {
  BRANCH_COPY, awaitingApproval, bulkOutcomeLine, forEachBranch, goLiveOf, menuCopyLines, newCopyKey, ownerStepWords, refusalWords, storeLabel, type MenuCopyResult,
} from '../../../lib/branches';
import { orderStatusLabel } from '../../../lib/orderStatus';

const TERMINAL = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'FAILED', 'REFUNDED', 'RETURNED']);

/**
 * [CHAINS PR2 · owner 29 Oct 2026] Branches: every branch at a glance (sales today / 7 / 30 days, orders waiting, which
 * branch waits for Swift's approval), every branch's live orders on one board, and the few things a chain does to
 * several branches at once — pause or take orders, give them this branch's hours, copy a menu into a new branch.
 * Each bulk action is one call per branch over that branch's own route, so every branch's own rules still apply.
 */
export function VendorBranchesScreen({ navigation }: { navigation?: { navigate?: (s: string, p?: Record<string, unknown>) => void; goBack?: () => void } }) {
  const qc = useQueryClient();
  const { store, myRole } = useVendorProfile();
  const isOwner = myRole === 'OWNER';
  const canManage = myRole === 'OWNER' || myRole === 'MANAGER';
  const storesQ = useBranchStores();
  const summaryQ = useBranchesSummary(canManage);
  const ordersQ = useAllBranchOrders();
  const hoursQ = useVendorHours();
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const stores: BranchStore[] = storesQ.data?.stores ?? [];
  const nameOf = (id: string) => stores.find((s) => s.id === id)?.name ?? 'a branch';

  // Bulk: the branches picked (approved ones only: a waiting branch takes no orders yet).
  const live = stores.filter((s) => !awaitingApproval(s));
  // [REVIEW-F #2220 S3-1] Branches not live yet, each saying whose turn it is; the owner's steps open the branch.
  const notLive = stores.filter((s) => awaitingApproval(s));
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['vendor'] });
  };
  const runBulk = async (label: string, call: (id: string) => Promise<unknown>) => {
    if (busy || picked.length === 0) return;
    setBusy(label);
    setOutcome(null);
    try {
      const result = await forEachBranch(picked, call);
      setOutcome(bulkOutcomeLine(result, nameOf));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const hours = hoursQ.data ?? null;
  const hoursTargets = picked.filter((id) => id !== store?.id);

  // Copy a menu: into one branch from another; the key is kept for a retry of the same pair.
  const copyMenu = useCopyMenu();
  const [copyFrom, setCopyFrom] = useState<string | null>(null);
  const [copyTo, setCopyTo] = useState<string | null>(null);
  const [copyKey, setCopyKey] = useState(newCopyKey);
  const pickCopy = (from: string | null, to: string | null) => { setCopyFrom(from); setCopyTo(to); setCopyKey(newCopyKey()); copyMenu.reset(); };
  const copied = copyMenu.data as MenuCopyResult | undefined;

  const summary = summaryQ.data;
  const orders = (ordersQ.data ?? []).filter((o: any) => !TERMINAL.has(o.status));

  return (
    <Screen>
      <Header title="Branches" />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space['3xl'] }}>
        {isOwner ? (
          <PillButton label="Add a branch" onPress={() => navigation?.navigate?.('VendorAddBranch')} />
        ) : null}

        {storesQ.isLoading ? <LoadingBlock /> : null}
        {storesQ.isError ? <ErrorState onRetry={() => void storesQ.refetch()} message="Couldn't load your branches." /> : null}

        {isOwner && notLive.length > 0 ? (
          <Card>
            <T variant="title">Not live yet</T>
            {notLive.map((s) => {
              const steps = ownerStepWords(s);
              return (
                <View key={s.id} style={{ marginTop: space.md, gap: 4 }}>
                  <T variant="label" weight="semibold">{storeLabel(s)}</T>
                  {steps.map((line) => <T key={line} variant="caption" tone="muted">{`• ${line}`}</T>)}
                  {goLiveOf(s)?.waitingFor === 'OWNER' ? (
                    <PillButton label={BRANCH_COPY.finishButton} size="sm" variant="soft" style={{ alignSelf: 'flex-start', marginTop: 4 }}
                      onPress={() => setSelectedStore(s.id)} />
                  ) : null}
                </View>
              );
            })}
          </Card>
        ) : null}

        {canManage && summary ? (
          <Card>
            <T variant="title">All branches</T>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              {`Today ${moneyIn(summary.total.today.revenue)} · ${summary.total.today.orders} orders`}
            </T>
            <T variant="caption" tone="muted">{`7 days ${moneyIn(summary.total.week.revenue)} · 30 days ${moneyIn(summary.total.month.revenue)}`}</T>
            <T variant="caption" tone="muted">{`Orders waiting: ${summary.total.pendingOrders}`}</T>
            <View style={{ marginTop: space.md, gap: space.sm }}>
              {summary.branches.map((b) => (
                <View key={b.vendorId}>
                  <T variant="label" weight="semibold">{storeLabel(stores.find((s) => s.id === b.vendorId) ?? { name: b.name })}</T>
                  <T variant="caption" tone="muted">
                    {`Today ${moneyIn(b.today.revenue)} · ${b.today.orders} orders · 7 days ${moneyIn(b.week.revenue)} · waiting ${b.pendingOrders}`}
                  </T>
                </View>
              ))}
            </View>
          </Card>
        ) : null}
        {canManage && summaryQ.isError ? (
          <ErrorState onRetry={() => void summaryQ.refetch()} message="Couldn't load the branch totals." />
        ) : null}

        {!canManage && stores.length > 0 ? (
          <Card>
            <T variant="title">Your branches</T>
            {stores.map((s) => <T key={s.id} variant="label" style={{ marginTop: 4 }}>{storeLabel(s)}</T>)}
          </Card>
        ) : null}

        <Card>
          <T variant="title">Live orders, all branches</T>
          {ordersQ.isError ? <ErrorState onRetry={() => void ordersQ.refetch()} message="Couldn't load the orders." /> : null}
          {!ordersQ.isLoading && !ordersQ.isError && orders.length === 0 ? (
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>No live orders right now.</T>
          ) : null}
          {orders.map((o: any) => (
            <View key={o.id} style={{ marginTop: space.sm, flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <T variant="label" weight="semibold">{`#${o.orderNumber} · ${o.vendor?.name ?? nameOf(o.vendorId)}`}</T>
                <T variant="caption" tone="muted">{`${orderStatusLabel(o.status)} · ${moneyIn(Number(o.totalAmount))}`}</T>
              </View>
              {o.vendor?.id && o.vendor.id !== store?.id ? (
                <PillButton label="Open branch" size="sm" variant="soft" onPress={() => setSelectedStore(o.vendor.id)} />
              ) : null}
            </View>
          ))}
        </Card>

        {canManage && live.length > 1 ? (
          <Card>
            <T variant="title">Several branches at once</T>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              Pick the branches. Each one is changed on its own, one after another, so a branch that can’t take a change says why.
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
              {live.map((s) => <Chip key={s.id} label={s.name} selected={picked.includes(s.id)} onPress={() => toggle(s.id)} />)}
            </View>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md, flexWrap: 'wrap' }}>
              <PillButton label="Pause orders" size="sm" variant="soft" disabled={picked.length === 0 || !!busy} loading={busy === 'pause'}
                onPress={() => void runBulk('pause', (id) => vendorApi.toggleOrdersAt(id, false))} />
              <PillButton label="Take orders" size="sm" variant="soft" disabled={picked.length === 0 || !!busy} loading={busy === 'take'}
                onPress={() => void runBulk('take', (id) => vendorApi.toggleOrdersAt(id, true))} />
            </View>
            {store && hours && hours.length > 0 ? (
              <PillButton
                label={`Give them ${store.name}’s hours`}
                size="sm"
                variant="soft"
                style={{ marginTop: space.sm }}
                disabled={hoursTargets.length === 0 || !!busy}
                loading={busy === 'hours'}
                onPress={() => void (async () => {
                  if (busy || hoursTargets.length === 0) return;
                  setBusy('hours');
                  setOutcome(null);
                  try {
                    setOutcome(bulkOutcomeLine(await forEachBranch(hoursTargets, (id) => vendorApi.setHoursAt(id, hours)), nameOf));
                  } finally {
                    setBusy(null);
                    refresh();
                  }
                })()}
              />
            ) : null}
            {outcome ? <T variant="caption" style={{ marginTop: space.sm }}>{outcome}</T> : null}
          </Card>
        ) : null}

        {canManage && stores.length > 1 ? (
          <Card>
            <T variant="title">Copy a menu</T>
            <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
              Into a branch whose menu is still empty. Prices, options and photos come across; stock counts don’t (each branch counts its own).
            </T>
            <T variant="label" weight="semibold" style={{ marginTop: space.md }}>From</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 4 }}>
              {stores.map((s) => <Chip key={s.id} label={s.name} selected={copyFrom === s.id} onPress={() => pickCopy(s.id, copyTo === s.id ? null : copyTo)} />)}
            </View>
            <T variant="label" weight="semibold" style={{ marginTop: space.md }}>Into</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 4 }}>
              {stores.filter((s) => s.id !== copyFrom).map((s) => <Chip key={s.id} label={s.name} selected={copyTo === s.id} onPress={() => pickCopy(copyFrom, s.id)} />)}
            </View>
            <PillButton
              label={!copyFrom || !copyTo ? 'Choose both branches' : `Copy ${nameOf(copyFrom)}’s menu`}
              style={{ marginTop: space.md }}
              disabled={!copyFrom || !copyTo || copyFrom === copyTo}
              loading={copyMenu.isPending}
              onPress={() => copyFrom && copyTo && copyMenu.mutate({ toStoreId: copyTo, fromStoreId: copyFrom, copyKey })}
            />
            {copyMenu.isError ? <T variant="caption" tone="error" style={{ marginTop: space.sm }}>{refusalWords(copyMenu.error, 'Couldn’t copy the menu. Try again.')}</T> : null}
            {copied ? menuCopyLines(copied).map((line) => <T key={line} variant="caption" style={{ marginTop: 4 }}>{line}</T>) : null}
          </Card>
        ) : null}

        <T variant="caption" tone="muted" style={{ color: color.text.muted }}>{BRANCH_COPY.ownFee}</T>
      </ScrollView>
    </Screen>
  );
}
