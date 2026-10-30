import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, PillButton, T } from '../../kit';
import { vendorApi } from '../../services/api';
import { moneyIn } from '../../lib/money';
import { STORE_ROLES, storeFeeAck, storeFeeToTick } from './storeWeeklyFee';

/** The server's message for a refused tick, or a plain retry line. */
function errorCopy(error: unknown): string {
  const body = (error as { response?: { data?: { error?: { message?: string } } } } | null)?.response?.data?.error;
  return body?.message ?? 'Couldn’t save your answer. Try again.';
}

/**
 * [RETIER PR-A2 · owner 30 Oct 2026] The selected store's weekly fee, on its go-live checklist, when it follows the
 * store's catalogue above the first step: the exact amount, why, the weekly-fee words and the tick. The server records
 * the tick for exactly the amount shown and makes the store live; a changed amount is refused and the card shows the
 * new one. Nothing is charged before the tick.
 */
export function StoreWeeklyFeeCard({ role }: { role: string }) {
  const qc = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const enabled = STORE_ROLES.has(role);
  const view = useQuery({ queryKey: ['vendor', 'store-weekly-fee'], queryFn: () => vendorApi.storeWeeklyFee().then((r) => r.data?.data ?? null), enabled });
  const fee = storeFeeToTick(view.data);
  const save = useMutation({
    mutationFn: () => vendorApi.tickStoreWeeklyFee(storeFeeAck(fee!)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'store-weekly-fee'] });
      void qc.invalidateQueries({ queryKey: ['verification', role] });
    },
  });
  if (!enabled || !fee) return null;
  return (
    <Card style={{ marginTop: space.md, gap: space.sm }}>
      <T variant="label" weight="bold">Your weekly fee: {moneyIn(fee.amount, fee.currencyCode)} a week</T>
      {fee.why ? <T variant="caption" tone="muted">{fee.why}</T> : null}
      {fee.items.map((item) => (
        <T key={item.heading} variant="caption"><T variant="caption" weight="bold">{item.heading}: </T>{item.text}</T>
      ))}
      <View style={{ gap: space.sm }}>
        <BrandCheckbox checked={ticked} onToggle={() => setTicked((t) => !t)} label={fee.tick} />
        <PillButton label="Confirm" disabled={!ticked} loading={save.isPending} onPress={() => save.mutate()} />
        {save.isError ? <T variant="caption" tone="error">{errorCopy(save.error)}</T> : null}
      </View>
    </Card>
  );
}
