import { useEffect, useState } from 'react';
import { AppState, ScrollView, View } from 'react-native';
import { PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOwnedSosAlerts } from '../../hooks/owned-safety';
import { useAuthStore } from '../../stores/authStore';
import { OwnedSosActions } from './OwnedSosActions';
import { SosCeremony } from './SosCeremony';

function SignedInSafetyPanel() {
  const query = useOwnedSosAlerts();
  const insets = useSafeAreaInsets();
  const { refetch } = query;
  const [visible, setVisible] = useState(false);
  const [resumedId, setResumedId] = useState<string | null>(null);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void refetch(); });
    return () => listener.remove();
  }, [refetch]);
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  // [73] Only a live alert earns a control over every screen; the monitoring
  // setting lives in Profile. Nothing floats over the app when all is calm.
  if (!rows.length && !visible && !resumedId) return null;
  return <>
    {rows.length ? (
      // [#1955 S4-3] Below the safe area and the header, centred: never over a header's side buttons.
      <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 56, left: 0, right: 0, alignItems: 'center' }}>
        <PillButton label={rows.length === 1 ? 'My safety alert' : `My safety alerts (${rows.length})`} variant="soft" onPress={() => { setVisible(true); void query.refetch(); }} />
      </View>
    ) : null}
    <PopupCard visible={visible} onClose={() => setVisible(false)}>
      <PopupTitle variant="title">My safety</PopupTitle>
      <ScrollView style={{ maxHeight: 420 }}>
        {query.isPending ? <T variant="body">Checking for your active alerts…</T> : null}
        {query.isError ? <T variant="body" accessibilityRole="alert">Your active alerts could not be refreshed. Try again when you have signal.</T> : null}
        {!query.isPending && !query.isError && !rows.length ? <T variant="body">Swift reports no active alerts for your account.</T> : null}
        {rows.map((row) => <View key={row.id}>
          <T variant="label">Your alert: {row.status === 'TRIGGER_PENDING' ? 'not sent yet' : row.status === 'ACKNOWLEDGED' ? 'Acknowledged by the safety team' : 'Active'}</T>
          {row.status === 'TRIGGER_PENDING' ? <PillButton label="Cancel or send now" onPress={() => setResumedId(row.id)} /> : <OwnedSosActions key={row.id} id={row.id} />}
        </View>)}
        {query.hasNextPage ? <PillButton label="More of my alerts" disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} /> : null}
        <PillButton label="Refresh my safety alerts" disabled={query.isFetching} onPress={() => { void query.refetch(); }} />
      </ScrollView>
      <PillButton label="Close" onPress={() => setVisible(false)} />
    </PopupCard>
    {resumedId ? <SosCeremony key={resumedId} visible onClose={() => { setResumedId(null); void query.refetch(); }} resumeAlertId={resumedId} context={{ orderId: '' }} getCoords={() => undefined} recordNoun="alert" /> : null}
  </>;
}
export function OwnedSafetyPanel() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  return isAuthenticated && user ? <SignedInSafetyPanel key={`${user.id}:${sessionGeneration}`} /> : null;
}
