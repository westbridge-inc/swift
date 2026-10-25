import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, PillButton, T } from '../../kit';
import { vendorApi } from '../../services/api';
import { OWN_NAME_DECLARATION_V1, OWN_NAME_HINT, OWN_NAME_TICK, ownNameSigningFor } from '../../lib/ownNameCopy';

/** The server's message for a refused signature, or a plain retry line. */
function errorCopy(error: unknown): string {
  const body = (error as { response?: { data?: { error?: { message?: string } } } } | null)?.response?.data?.error;
  return body?.message ?? 'Couldn’t sign the declaration. Try again.';
}

/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] The own-name choice on a store's Documents checklist.
 *  - `mode="sign"`: the store trades under its owner's own name and its declaration is missing or was rejected —
 *    show the words, the tick and "Sign"; once signed it waits for a person, like any document.
 *  - `mode="offer"`: the store asks for a business registration it does not have yet — offer the own-name route.
 *  - `mode="drop"`: the store trades under its owner's own name — offer "I use a registered business name instead".
 * The server decides everything (name check, refusals); this card only asks and shows the answer.
 */
export function OwnNameCard({ role, mode, storeName }: { role: string; mode: 'sign' | 'offer' | 'drop'; storeName?: string | null }) {
  const forStore = ownNameSigningFor(storeName);
  const qc = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const [open, setOpen] = useState(mode === 'sign');
  const done = () => void qc.invalidateQueries({ queryKey: ['verification', role] });
  const sign = useMutation({ mutationFn: () => vendorApi.signOwnName(), onSuccess: done });
  const drop = useMutation({ mutationFn: () => vendorApi.dropOwnName(), onSuccess: done });

  if (mode === 'drop') {
    return (
      <View style={{ marginTop: space.sm }}>
        <PillButton label="I use a registered business name instead" variant="soft" size="sm" loading={drop.isPending} onPress={() => drop.mutate()} />
        {drop.isError ? <T variant="caption" tone="error">{errorCopy(drop.error)}</T> : null}
      </View>
    );
  }
  return (
    <Card style={{ marginTop: space.md, gap: space.sm }}>
      <T variant="label" weight="bold">{mode === 'sign' ? 'Sign: I trade under my own name' : 'No business name? Trade under your own name'}</T>
      <T variant="caption" tone="muted">{OWN_NAME_HINT}</T>
      {forStore ? <T variant="caption" weight="bold">{forStore}</T> : null}
      {open ? (
        <>
          <T variant="caption">{OWN_NAME_DECLARATION_V1}</T>
          <BrandCheckbox checked={ticked} onToggle={() => setTicked((t) => !t)} label={OWN_NAME_TICK} />
          <PillButton label="Sign the declaration" disabled={!ticked} loading={sign.isPending} onPress={() => sign.mutate()} />
          {sign.isError ? <T variant="caption" tone="error">{errorCopy(sign.error)}</T> : null}
        </>
      ) : (
        <PillButton label="My store's name is my own name" variant="soft" size="sm" onPress={() => setOpen(true)} />
      )}
    </Card>
  );
}
