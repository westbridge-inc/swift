import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, PillButton, T } from '../../kit';
import { vendorApi } from '../../services/api';
import { moneyIn } from '../../lib/money';
import { storeFeeAck, storeFeeCardEnabled, storeFeeCardView, storeFeeKey, tickHolds, type StoreFeeToTick } from './storeWeeklyFee';

/** The server's message for a refused tick, or a plain retry line. */
function errorCopy(error: unknown): string {
  const body = (error as { response?: { data?: { error?: { message?: string } } } } | null)?.response?.data?.error;
  return body?.message ?? 'Couldn’t save your answer. Try again.';
}

/** Which store's fee, and whether the person looking owns it (only the owner ever sees or ticks it). */
export interface StoreFeeScope { vendorId: string; isOwner: boolean }

/**
 * [RETIER PR-A2 · owner 30 Oct 2026] The store's weekly fee, on its go-live checklist, when it follows the store's
 * catalogue above the first step: the exact amount, why, the weekly-fee words and the tick. OWNER only, for the store
 * named (read and ticked with that store's id, never whichever store happens to be selected). The tick is given to the
 * exact fee on screen: if another amount, currency or version arrives, or the save fails, the box empties. A read that
 * failed shows an error with Try again, never nothing (REVIEW-F #2246 S3-1). Nothing is charged before the tick.
 */
export function StoreWeeklyFeeCard({ role, scope }: { role: string; scope?: StoreFeeScope | null }) {
  const qc = useQueryClient();
  const [tickedKey, setTickedKey] = useState<string | null>(null);
  const vendorId = scope?.vendorId ?? null;
  const enabled = storeFeeCardEnabled(role, scope);
  const read = useQuery({
    queryKey: ['vendor', 'store-weekly-fee', vendorId],
    queryFn: () => vendorApi.storeWeeklyFee(vendorId!).then((r) => r.data?.data ?? null),
    enabled,
  });
  const view = storeFeeCardView(role, scope, { data: read.data, isError: read.isError });
  const fee = view.kind === 'tick' ? view.fee : null;
  const checked = tickHolds(tickedKey, fee);
  const save = useMutation({
    mutationFn: (shown: StoreFeeToTick) => vendorApi.tickStoreWeeklyFee(storeFeeAck(shown)),
    onError: () => setTickedKey(null),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'store-weekly-fee', vendorId] });
      void qc.invalidateQueries({ queryKey: ['verification', role] });
    },
  });
  if (save.isSuccess && view.kind === 'none') {
    return (
      <Card style={{ marginTop: space.md }}>
        <T variant="caption" tone="muted">Saved. Your store goes live once Swift’s other checks are done.</T>
      </Card>
    );
  }
  if (view.kind === 'error') {
    return (
      <Card style={{ marginTop: space.md, gap: space.sm }}>
        <T variant="label" weight="bold">Couldn’t load your weekly fee</T>
        <T variant="caption" tone="muted">This is not an all-clear: we could not check it. Your store goes live only after you read and tick it.</T>
        <PillButton label="Try again" variant="soft" onPress={() => void read.refetch()} />
      </Card>
    );
  }
  if (!fee) return null;
  const key = storeFeeKey(fee);
  return (
    <Card style={{ marginTop: space.md, gap: space.sm }}>
      <T variant="label" weight="bold">Your weekly fee: {moneyIn(fee.amount, fee.currencyCode)} a week</T>
      {fee.why ? <T variant="caption" tone="muted">{fee.why}</T> : null}
      {fee.items.map((item) => (
        <T key={item.heading} variant="caption"><T variant="caption" weight="bold">{item.heading}: </T>{item.text}</T>
      ))}
      <View style={{ gap: space.sm }}>
        <BrandCheckbox checked={checked} onToggle={() => setTickedKey(checked ? null : key)} label={fee.tick} />
        <PillButton label="Confirm" disabled={!checked} loading={save.isPending} onPress={() => { if (checked) save.mutate(fee); }} />
        {save.isError ? <T variant="caption" tone="error">{errorCopy(save.error)}</T> : null}
      </View>
    </Card>
  );
}
