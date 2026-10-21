import { useRef, useState } from 'react';
import { View } from 'react-native';
import { BrandSwitch } from '../../kit/controls';
import { space } from '@swift/ui';
import { PillButton, T } from '../../kit';
import { useMonitoringPreference } from '../../hooks/owned-safety';
import { requireAuthSessionForPrincipal, useAuthStore } from '../../stores/authStore';

function MonitoringControlBody() {
  const { query, save, owner } = useMonitoringPreference();
  const busy = useRef(false);
  // [#1955 S3-1] For a safety opt-in, "I turned it on" must mean it is on: the flip IS the save.
  // While the write and its read-back run, the switch shows the value being saved and cannot be
  // flipped again; afterwards it shows only what Swift read back. Nothing is a local draft.
  const [pending, setPending] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const known = typeof query.data === 'boolean' && !query.isError;
  const saving = pending !== null || save.isPending;
  const value = pending ?? query.data;
  const status = query.isPending ? 'Reading your saved setting…'
    : query.isError ? 'Could not verify your saved setting.'
    : saving ? 'Saving and checking with Swift…'
    : typeof query.data === 'boolean' ? '' : 'Saved setting unknown.';
  return <View style={{ paddingVertical: space.md, gap: space.sm }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1 }}>
        <T variant="body" weight="semibold">Extra safety check-ins on my trips</T>
        <T variant="caption" tone="muted">Swift keeps a closer watch on your trips and checks in sooner when something looks wrong.{status ? ` ${status}` : ''}</T>
      </View>
      <BrandSwitch label="Extra safety check-ins on my trips" value={value === true} disabled={!known || saving} onChange={(enabled: boolean) => {
        if (!known || saving || busy.current || enabled === query.data) return;
        busy.current = true;
        setPending(enabled);
        setMessage(null);
        save.mutate(enabled, {
          onSettled: () => { busy.current = false; },
          onSuccess: (saved) => { try { requireAuthSessionForPrincipal(owner); setPending(null); setMessage(`Saved and checked with Swift: extra check-ins are ${saved ? 'on' : 'off'}.`); } catch { /* obsolete account */ } },
          onError: () => { try { requireAuthSessionForPrincipal(owner); setPending(null); setMessage('Your change could not be confirmed. Try again.'); } catch { /* obsolete account */ } },
        });
      }} />
    </View>
    {message ? <T variant="caption" accessibilityRole="alert">{message}</T> : null}
    {query.isError ? <PillButton label="Refresh safety preference" variant="soft" disabled={query.isFetching || saving} onPress={() => { setMessage(null); void query.refetch(); }} /> : null}
  </View>;
}

export function MonitoringControl() {
  const user = useAuthStore((s) => s.user);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  return <MonitoringControlBody key={`${user?.id ?? 'guest'}:${sessionGeneration}`} />;
}
