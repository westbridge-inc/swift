/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { WeeklyFeeTerms } from '../../../components/onboarding/WeeklyFeeTerms';
import { useAcknowledgeProviderFee, useProviderFee } from '../../../hooks';
import { PRO_FEE_COVERED_COPY, proFeeTick } from '../../../lib/providerFee';

/**
 * [BILL-PRO PR5 · owner A4/B3] A pro's own weekly fee, in the customer app where pros work. The server decides
 * everything shown (GET /api/v1/provider/subscription):
 *  - covered by the pro's own Services store's fee (one fee): said so; nothing to pay here;
 *  - "I understand the weekly fee" not yet ticked: the server's words and amount, and the tick;
 *  - a fee: the shared weekly-fee screen (MMG's checkout page only; Pay appears only when the server says it is live);
 *  - no fee yet: said so.
 */
export function ProviderWeeklyFeeScreen({ route }: { route?: { params?: { ref?: string } } }) {
  const q = useProviderFee();
  const ack = useAcknowledgeProviderFee();
  const [ticked, setTicked] = useState(false);
  const view = q.data;
  const tick = proFeeTick(view);

  if (view?.data && tick.kind === 'none' && !view.coveredBy) {
    return <WeeklyFeeScreen family="provider" sub={view.data} loading={q.isLoading} error={q.isError} refresh={q.refetch} checkoutRef={route?.params?.ref} />;
  }
  return (
    <Screen>
      <Header title="Weekly fee" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'], gap: space.xl }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState message="We couldn't load your weekly fee. Check your connection and try again." onRetry={() => void q.refetch()} /> : null}
        {view?.coveredBy === 'STORE' ? (
          <Card>
            <T variant="label" weight="semibold">Your store's weekly fee covers you</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              {PRO_FEE_COVERED_COPY}
            </T>
          </Card>
        ) : null}
        {tick.kind === 'tick' ? (
          <Card>
            <T variant="label" weight="semibold">The weekly fee for service providers</T>
            <WeeklyFeeTerms fee={tick} ticked={ticked} onToggle={() => setTicked((value) => !value)} />
            {ack.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                {(ack.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? "We couldn't save your tick. Try again."}
              </T>
            ) : null}
            <PillButton
              label="Continue"
              disabled={!ticked || ack.isPending}
              onPress={() => ack.mutate(tick.ack, { onSettled: () => void q.refetch() })}
              style={{ marginTop: space.md }}
            />
          </Card>
        ) : null}
        {view && !view.data && tick.kind === 'none' && view.coveredBy !== 'STORE' ? (
          <Card>
            <T variant="label" weight="semibold">No weekly fee yet</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              Swift tells you in the app before the weekly fee starts for service providers. Nothing is charged until then.
            </T>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
