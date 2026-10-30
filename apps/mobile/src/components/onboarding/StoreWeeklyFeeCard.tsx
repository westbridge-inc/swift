import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, PillButton, T } from '../../kit';
import { vendorApi } from '../../services/api';
import { moneyIn } from '../../lib/money';
import { storeFeeAck, storeFeeCardEnabled, storeFeeKey, storeFeeToTick, tickHolds, type StoreFeeToTick } from './storeWeeklyFee';

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
 * exact fee on screen: if another amount, currency or version arrives, or the save fails, the box empties. The server
 * records the tick only for its own current quote and makes the store live. Nothing is charged before the tick.
 */
export function StoreWeeklyFeeCard({ role, scope }: { role: string; scope?: StoreFeeScope | null }) {
  const qc = useQueryClient();
  const [tickedKey, setTickedKey] = useState<string | null>(null);
  const vendorId = scope?.vendorId ?? null;
  const enabled = storeFeeCardEnabled(role, scope);
  const view = useQuery({
    queryKey: ['vendor', 'store-weekly-fee', vendorId],
    queryFn: () => vendorApi.storeWeeklyFee(vendorId!).then((r) => r.data?.data ?? null),
    enabled,
  });
  const fee = enabled ? storeFeeToTick(view.data, vendorId) : null;
  const key = fee ? storeFeeKey(fee) : null;
  const checked = tickHolds(tickedKey, fee);
  const save = useMutation({
    mutationFn: (shown: StoreFeeToTick) => vendorApi.tickStoreWeeklyFee(storeFeeAck(shown)),
    onError: () => setTickedKey(null),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'store-weekly-fee', vendorId] });
      void qc.invalidateQueries({ queryKey: ['verification', role] });
    },
  });
  if (!fee || !key) return null;
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
