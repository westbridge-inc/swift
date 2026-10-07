import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { BrandSwitch } from '../../kit/controls';
import { space } from '@swift/ui';
import { PillButton, T } from '../../kit';
import { useMonitoringPreference } from '../../hooks/owned-safety';
import { requireAuthSessionForPrincipal, useAuthStore } from '../../stores/authStore';

function MonitoringControlBody() {
  const { query, save, owner } = useMonitoringPreference();
  const busy = useRef(false);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setDraft(typeof query.data === 'boolean' ? query.data : null); setMessage(null); }, [query.data, owner.userId, owner.generation]);
  const value = draft ?? query.data;
  const known = typeof query.data === 'boolean' && !query.isError;
  const status = query.isPending ? 'Reading your saved setting…' : query.isError ? 'Could not verify your saved setting.' : typeof query.data === 'boolean' ? `Last saved setting: ${query.data ? 'On' : 'Off'}` : 'Saved setting unknown.';
  return <View style={{ paddingVertical: space.md, gap: space.sm }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1 }}>
        <T variant="body" weight="semibold">Extra safety check-ins on my trips</T>
        <T variant="caption" tone="muted">Swift keeps a closer watch on your trips and checks in sooner when something looks wrong. {status}</T>
      </View>
      <BrandSwitch label="Extra safety check-ins on my trips" value={value === true} disabled={!known || save.isPending} onChange={(enabled: boolean) => { setDraft(enabled); setMessage(null); }} />
    </View>
    <PillButton label={save.isPending ? 'Saving…' : 'Save safety preference'} disabled={!known || typeof value !== 'boolean' || save.isPending || value === query.data} loading={save.isPending} onPress={() => {
      if (!known || typeof value !== 'boolean' || save.isPending || busy.current) return;
      busy.current = true;
      setMessage(null);
      save.mutate(value, {
        onSettled: () => { busy.current = false; },
        onSuccess: (saved) => { try { requireAuthSessionForPrincipal(owner); setDraft(saved); setMessage('Saved and checked with Swift.'); } catch { /* obsolete account */ } },
        onError: () => { try { requireAuthSessionForPrincipal(owner); setDraft(query.data ?? null); setMessage('Could not verify the change. Your draft was restored. Refresh before trying again.'); } catch { /* obsolete account */ } },
      });
    }} />
    {message ? <T variant="caption" accessibilityRole="alert">{message}</T> : null}
    {query.isError ? <PillButton label="Refresh safety preference" variant="soft" disabled={query.isFetching || save.isPending} onPress={() => { setMessage(null); void query.refetch(); }} /> : null}
  </View>;
}

export function MonitoringControl() {
  const user = useAuthStore((s) => s.user);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  return <MonitoringControlBody key={`${user?.id ?? 'guest'}:${sessionGeneration}`} />;
}
