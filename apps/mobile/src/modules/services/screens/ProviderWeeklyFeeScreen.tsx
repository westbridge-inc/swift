/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { WeeklyFeeScreen } from '../../billing/screens/WeeklyFeeScreen';
import { WeeklyFeeTerms } from '../../../components/onboarding/WeeklyFeeTerms';
import { useAcknowledgeProviderFee, useProviderFee, useServiceProviderProfile } from '../../../hooks';
import { useCheckingLatest } from '../../../lib/checkingLatest';
import {
  PRO_FEE_COVERED_COPY, PRO_FEE_COVERED_TICK_LINE, PRO_FEE_OWN_FEE_LINK, proFeeAgreementFirst, proFeeChangedLine, proFeeNoFeeWords, proFeeRunningUnlistedLine, proFeeTick, proFeeTickRunningLine, proFeeTickStartsLine,
} from '../../../lib/providerFee';

/**
 * [BILL-PRO PR5 · owner A4/B3] A pro's own weekly fee, in the customer app where pros work. The server decides
 * everything shown (GET /api/v1/provider/subscription):
 *  - covered by the pro's own Services store's fee (one fee): said so, before and with the tick (REVIEW-F #2231 S3-3);
 *    their own fee (credit, receipts) stays one tap away (S4-3);
 *  - "I understand the weekly fee" to give: the server's words and amount, a tick kept only for THAT amount (S3-1),
 *    "the fee changed to X, confirm again" when the amount moved since they ticked (REVIEW-G #2230 S3-1), and the line
 *    saying the tick starts the fee for an approved pro (S4-4) only when the tick is all that is missing; with the
 *    Business Agreement not accepted, the agreement words and its Review button instead (S4). A fee that exists stays
 *    reachable (PINV-8, S4-1);
 *  - a fee: the shared weekly-fee screen (MMG's checkout page only; Pay appears only when the server says it is live);
 *  - no fee: words from where the server says the pro stands (S3-2).
 */
/** The agreement is asked by the app's own legal-acceptance screen: asking the server again brings it up now. */
function ReviewAgreementButton() {
  const qc = useQueryClient();
  return (
    <PillButton
      label="Review the agreement"
      onPress={() => void qc.invalidateQueries({ queryKey: ['legal-acceptance'] })}
      style={{ marginTop: space.md }}
    />
  );
}

export function ProviderWeeklyFeeScreen({ route }: { route?: { params?: { ref?: string } } }) {
  const q = useProviderFee();
  const checkingLatest = useCheckingLatest(q);
  const me = useServiceProviderProfile<{ isVerified?: boolean }>();
  const ack = useAcknowledgeProviderFee();
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const [showOwnFee, setShowOwnFee] = useState(false);
  const view = q.data;
  const tick = proFeeTick(view);
  const ticked = tick.kind === 'tick' && tickedFor === tick.key;
  const isVerified = me.data?.isVerified;
  const changed = proFeeChangedLine(view);
  const startsLine = proFeeTickStartsLine(view, isVerified);
  const runningLine = proFeeTickRunningLine(view);
  const unlistedLine = proFeeRunningUnlistedLine(view);
  const agreementFirst = proFeeAgreementFirst(view);
  const noFee = proFeeNoFeeWords(view, isVerified);

  if (view?.data && (showOwnFee || (tick.kind === 'none' && !view.coveredBy))) {
    return <WeeklyFeeScreen family="provider" sub={view.data} loading={q.isLoading} error={q.isError} refresh={q.refetch} checkoutRef={route?.params?.ref} checkingLatest={checkingLatest} />;
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
            {tick.kind === 'tick' ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{PRO_FEE_COVERED_TICK_LINE}</T>
            ) : null}
          </Card>
        ) : null}
        {agreementFirst ? (
          <Card>
            <T variant="label" weight="semibold">{agreementFirst.title}</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{agreementFirst.body}</T>
            <ReviewAgreementButton />
          </Card>
        ) : null}
        {tick.kind === 'tick' ? (
          <Card>
            <T variant="label" weight="semibold">The weekly fee for service providers</T>
            {changed ? (
              <T variant="caption" tone="error" style={{ marginTop: space.xs }}>{changed}</T>
            ) : null}
            <WeeklyFeeTerms fee={tick} ticked={ticked} onToggle={() => setTickedFor(ticked ? null : tick.key)} />
            {startsLine ? <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>{startsLine}</T> : null}
            {runningLine ? <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>{runningLine}</T> : null}
            {unlistedLine ? <T variant="caption" tone="error" style={{ marginTop: space.sm }}>{unlistedLine}</T> : null}
            {ack.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                {(ack.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? "We couldn't save your tick. Try again."}
              </T>
            ) : null}
            <PillButton
              label="Continue"
              disabled={!ticked || ack.isPending}
              // The tick goes with the amount it was given to; a refused one (the fee changed) leaves the box empty
              // for the new amount the refetch brings.
              onPress={() => ack.mutate(tick.ack, { onSettled: () => void q.refetch() })}
              style={{ marginTop: space.md }}
            />
          </Card>
        ) : null}
        {view?.data && !showOwnFee && (tick.kind === 'tick' || view.coveredBy === 'STORE') ? (
          // [PINV-8 · REVIEW-F #2231 S4-1/S4-3] A fee that exists is never hidden behind the tick or the store cover.
          <PillButton label={PRO_FEE_OWN_FEE_LINK} variant="soft" onPress={() => setShowOwnFee(true)} />
        ) : null}
        {view && !view.data && tick.kind === 'none' && view.coveredBy !== 'STORE' ? (
          <Card>
            <T variant="label" weight="semibold">{noFee.title}</T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>{noFee.body}</T>
            {noFee.action === 'AGREEMENT' ? <ReviewAgreementButton /> : null}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
