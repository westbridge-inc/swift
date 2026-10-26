import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, PillButton, T } from '../../kit';
import { vendorApi } from '../../services/api';
import { foodHandlerStoresToTick, foodHandlerTickFrom, type FoodHandlerStore } from './foodHandlers';

/** The server's message for a refused tick, or a plain retry line. */
function errorCopy(error: unknown): string {
  const body = (error as { response?: { data?: { error?: { message?: string } } } } | null)?.response?.data?.error;
  return body?.message ?? 'Couldn’t save your answer. Try again.';
}

function StoreTick({ role, store, tick, version, named }: { role: string; store: FoodHandlerStore; tick: string; version: string; named: boolean }) {
  const qc = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const save = useMutation({
    mutationFn: () => vendorApi.tickFoodHandlers(store.vendorId, version),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['verification', role] }),
  });
  return (
    <View style={{ gap: space.sm }}>
      {named ? <T variant="caption" weight="bold">{store.name}</T> : null}
      <BrandCheckbox checked={ticked} onToggle={() => setTicked((t) => !t)} label={tick} />
      <PillButton label="Confirm" disabled={!ticked} loading={save.isPending} onPress={() => save.mutate()} />
      {save.isError ? <T variant="caption" tone="error">{errorCopy(save.error)}</T> : null}
    </View>
  );
}

/**
 * [FOOD-PERMIT · owner ruling 24 Oct 2026] The food handlers step on a restaurant's Documents checklist: the owner
 * ticks, for each registered restaurant not yet confirmed, the server's words — "Everyone who handles food here holds
 * a current food handler's certificate." The server records the tick and decides everything (who may tick, going live).
 */
export function FoodHandlersCard({ role, status }: { role: string; status: unknown }) {
  const words = foodHandlerTickFrom(status);
  const stores = foodHandlerStoresToTick(status);
  if (!words || stores.length === 0) return null;
  return (
    <Card style={{ marginTop: space.md, gap: space.sm }}>
      <T variant="label" weight="bold">Your food handlers</T>
      <T variant="caption" tone="muted">
        Instead of uploading a certificate, confirm it for the people who handle food at your restaurant. You can still add your own food handler’s certificate below — customers see it on your store page.
      </T>
      {stores.map((store) => (
        <StoreTick key={store.vendorId} role={role} store={store} tick={words.tick} version={words.version} named={stores.length > 1} />
      ))}
    </Card>
  );
}
