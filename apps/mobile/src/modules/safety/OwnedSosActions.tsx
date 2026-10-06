import { useAuthStore } from '../../stores/authStore';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { PillButton, T } from '../../kit';
import { useMarkSafeSos, useOwnedSosAlert } from '../../hooks/owned-safety';

function OwnedSosActionsBody({ id }: { id: string }) {
  const query = useOwnedSosAlert(id);
  const markSafe = useMarkSafeSos();
  const busy = useRef(false);
  const [unknown, setUnknown] = useState(false);
  // A stale read after a refetch error is not current authority to write.
  const alert = !query.isError ? query.data : undefined;
  const live = alert?.status === 'ACTIVE' || alert?.status === 'ACKNOWLEDGED';
  return <View>
    {query.isPending ? <T variant="body">Checking your alert…</T> : null}
    {query.isError || unknown ? <T variant="body" accessibilityRole="alert">We could not confirm the result. Refresh your alert; your case may still be open.</T> : null}
    {alert?.userSafeFlaggedAt ? <T variant="body" accessibilityRole="alert">{live ? 'Swift recorded that you marked yourself safe. The safety team must still verify and close the case.' : 'Swift recorded that you marked yourself safe.'}</T> : null}
    {alert && !live && alert.status !== 'TRIGGER_PENDING' ? <T variant="body">Server alert status: {alert.status === 'RESOLVED' ? 'Resolved by the safety team' : 'Cancelled'}.</T> : null}
    {(live || !!alert?.userSafeFlaggedAt) ? <PillButton label={markSafe.isPending ? 'Sending safe flag…' : (alert?.userSafeFlaggedAt ? "Resend my saved safe flag" : "I'm safe now")} loading={markSafe.isPending} disabled={markSafe.isPending} onPress={() => {
      if (markSafe.isPending || busy.current) return;
      busy.current = true;
      setUnknown(false);
      markSafe.mutate(id, { onSuccess: () => { void query.refetch(); }, onError: () => { setUnknown(true); void query.refetch(); }, onSettled: () => { busy.current = false; } });
    }} /> : null}
    <PillButton label="Refresh my alert" variant="soft" disabled={query.isFetching || markSafe.isPending} onPress={() => { void query.refetch().then((result) => { if (!result.isError) setUnknown(false); }); }} />
  </View>;
}

export function OwnedSosActions({ id }: { id: string }) {
  const { user, sessionGeneration } = useAuthStore();
  return <OwnedSosActionsBody key={`${user?.id ?? 'guest'}:${sessionGeneration}:${id}`} id={id} />;
}
