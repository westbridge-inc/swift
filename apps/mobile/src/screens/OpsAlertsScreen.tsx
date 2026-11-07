/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { space } from '@swift/ui';
import { Card, ConfirmDialog, EmptyState, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../kit';
import { useAcknowledgeOpsAlert, useOpsAlerts } from '../hooks/opsAlerts';
import { alertLine, inScreenOrder, refusalOf, type OpsAlertRow } from '../lib/opsAlerts';

export type OpsAlertsParams = { opsAlertId?: string } | undefined;

// ---------------------------------------------------------------------------
// [DRILL-STORM · S-19 · GUARDRAILS §3] A responder's pages, on the phone.
//
// The pages that reach a responder's phone (an SOS, an operations page, the
// paging drill) re-page until someone acknowledges them — and until now the
// phone could only open the app on whatever screen it last showed. Tapping a
// page now opens this screen, at that page, with an Acknowledge button: it
// stops the re-pages for everyone and records who acknowledged it. It does
// not close an SOS. The server decides who may see and acknowledge pages (the
// admin role the account holds, whatever mode the app is in); anyone else is
// told so in words. Mission Control > Ops alerts is the same list.
// ---------------------------------------------------------------------------

export function OpsAlertsScreen() {
  const focusId = (useRoute().params as OpsAlertsParams)?.opsAlertId ?? null;
  const alerts = useOpsAlerts();
  const ack = useAcknowledgeOpsAlert();
  const [confirming, setConfirming] = useState<OpsAlertRow | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const now = alerts.dataUpdatedAt || Date.now();
  const rows = inScreenOrder(alerts.data ?? [], focusId);
  const refusal = alerts.isError ? refusalOf(alerts.error) : null;

  const acknowledge = (row: OpsAlertRow) => {
    setSaid(null);
    ack.mutate(row.id, {
      onSuccess: (res) => setSaid(res.acknowledged
        ? `Acknowledged: ${row.title}. The re-pages have stopped.`
        : 'Already handled: someone acknowledged it first, or it was closed.'),
      onError: (err) => setSaid(refusalOf(err) === 'not-a-responder'
        ? 'Only Swift operations staff can acknowledge this page.'
        : 'That did not go through. Check your connection and try again.'),
      onSettled: () => setConfirming(null),
    });
  };

  return (
    <Screen>
      <Header title="Ops alerts" />
      {alerts.isLoading ? (
        <LoadingBlock />
      ) : refusal === 'not-a-responder' ? (
        <EmptyState
          icon="lock"
          title="For Swift operations staff"
          body="Pages are acknowledged by the people Swift pages for operations. If you should be one of them, ask a Swift admin to check your account."
        />
      ) : refusal === 'signed-out' ? (
        <EmptyState icon="log-in" title="Sign in to see your pages" body="Sign in with the account Swift pages, then open this page again." />
      ) : refusal === 'failed' ? (
        <ErrorState message="Your pages could not be loaded. Check your connection and try again." onRetry={() => void alerts.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: space['2xl'], gap: space.md }}>
          <T variant="caption" tone="muted">
            A page keeps re-paging the responders and texting the on-call phones until someone acknowledges it.
            Acknowledge it when you have seen it and are handling it.
          </T>
          {said ? <T variant="body" weight="medium" accessibilityLiveRegion="polite">{said}</T> : null}
          {rows.length === 0 ? (
            <EmptyState
              icon="check-circle"
              title="Nothing is waiting for acknowledgement"
              body={focusId ? 'The page you opened was already acknowledged by someone, or it was closed.' : undefined}
            />
          ) : rows.map((row) => (
            <Card key={row.id} style={{ gap: space.sm, padding: space.md }} accessibilityLabel={row.title}>
              <T variant="caption" tone="muted">{alertLine(row, now)}</T>
              <T variant="body" weight="semibold">{row.title}</T>
              <T variant="body">{row.body}</T>
              {row.kind === 'SOS' ? (
                <T variant="caption" tone="muted">Acknowledging does not close the SOS: keep handling the person who asked for help.</T>
              ) : null}
              <View style={{ marginTop: space.sm }}>
                <PillButton
                  label="Acknowledge"
                  loading={ack.isPending && ack.variables === row.id}
                  onPress={() => setConfirming(row)}
                />
              </View>
            </Card>
          ))}
        </ScrollView>
      )}

      <ConfirmDialog
        open={confirming != null}
        title="Acknowledge this page?"
        body="You are saying you have seen it and are handling it. Swift stops re-paging everyone about it and records that you acknowledged it."
        confirmLabel="Acknowledge"
        loading={ack.isPending}
        onConfirm={() => { if (confirming) acknowledge(confirming); }}
        onClose={() => setConfirming(null)}
      />
    </Screen>
  );
}
