'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/auth';
import { WeeklyFee } from '@/components/weekly-fee';
import { askLegalAcceptanceAgain } from '@/lib/legal-acceptance';
import {
  acknowledgeProviderFee, PRO_FEE_COVERED_COPY, PRO_FEE_COVERED_TICK_LINE, PRO_FEE_OWN_FEE_LINK,
  proFeeAgreementFirst, proFeeChangedLine, proFeeMoney, proFeeNoFeeWords, proFeeTick, proFeeTickStartsLine, type ProFeeView,
} from '@/lib/provider-fee';

/**
 * [BILL-PRO PR6 · owner A4/B3] A pro's own weekly fee on the website, the same server answer and the same words as the
 * phone's pro fee screen (ProviderWeeklyFeeScreen):
 *  - covered by the pro's own Services store's fee (one fee): said so, before and with the tick (REVIEW-F #2231 S3-3);
 *    their own fee (credit, receipts) stays one click away (S4-3);
 *  - "I understand the weekly fee" to give: the server's words and amount, a tick kept only for THAT amount (S3-1),
 *    "the fee changed to X, confirm again" when the amount moved since they ticked (REVIEW-G #2230 S3-1), and the line
 *    saying the tick starts the fee for an approved pro (S4-4) only when the tick is all that is missing (FEE_TERMS);
 *    with the Business Agreement not accepted (AGREEMENT), the agreement card and its Review button instead (S4). A fee
 *    that exists stays reachable (PINV-8, S4-1);
 *  - a fee: the shared WeeklyFee (MMG's checkout page only; Pay appears only when the server says it is live);
 *  - no fee: words from where the server says the pro stands (S3-2).
 */
/** The agreement is asked by the site's own legal-acceptance gate: asking the server again brings it up now. */
function ReviewAgreementButton() {
  return <button type="button" className="sw-btn sw-btn-md sw-btn-outline" onClick={askLegalAcceptanceAgain}>Review the agreement</button>;
}

export function ProviderFeeBlock({ view, isVerified }: { view: ProFeeView; isVerified?: boolean }) {
  const client = useQueryClient();
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  const [showOwnFee, setShowOwnFee] = useState(false);
  const tick = proFeeTick(view);
  const ticked = tick.kind === 'tick' && tickedFor === tick.key;
  const changed = proFeeChangedLine(view);
  const startsLine = proFeeTickStartsLine(view, isVerified);
  const agreementFirst = proFeeAgreementFirst(view);
  const noFee = proFeeNoFeeWords(view, isVerified);
  const ack = useMutation({
    mutationFn: acknowledgeProviderFee,
    // A refused tick (the fee changed) leaves the box empty for the new amount the refetch brings.
    onSettled: () => { void client.invalidateQueries({ queryKey: ['provider-fee'] }); },
  });

  if (view.data && (showOwnFee || (tick.kind === 'none' && !view.coveredBy))) return <WeeklyFee family="provider" />;
  const failure = ack.error instanceof ApiRequestError ? ack.error.message : ack.isError ? "We couldn't save your tick. Try again." : '';
  return <div className="space-y-4">
    {view.coveredBy === 'STORE' ? <div className="sw-card space-y-2 p-6">
      <p className="font-semibold">Your store&rsquo;s weekly fee covers you</p>
      <p>{PRO_FEE_COVERED_COPY}</p>
      {tick.kind === 'tick' ? <p>{PRO_FEE_COVERED_TICK_LINE}</p> : null}
    </div> : null}
    {agreementFirst ? <div className="sw-card space-y-2 p-6">
      <p className="font-semibold">{agreementFirst.title}</p>
      <p>{agreementFirst.body}</p>
      <ReviewAgreementButton />
    </div> : null}
    {tick.kind === 'tick' ? <div className="sw-card space-y-3 p-6">
      <p className="font-semibold">The weekly fee for service providers: {proFeeMoney(tick.terms.amount, tick.terms.currencyCode)}/week</p>
      {changed ? <p role="alert">{changed}</p> : null}
      <ul className="space-y-1">
        {tick.terms.items.map((item) => <li key={item.heading}><span className="font-semibold">{item.heading}: </span>{item.text}</li>)}
      </ul>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={ticked} onChange={() => setTickedFor(ticked ? null : tick.key)} />
        <span>{tick.terms.tick}</span>
      </label>
      {startsLine ? <p>{startsLine}</p> : null}
      {failure ? <p role="alert">{failure}</p> : null}
      <button className="sw-btn sw-btn-md" disabled={!ticked || ack.isPending} onClick={() => ack.mutate(tick.ack)}>Continue</button>
    </div> : null}
    {view.data && !showOwnFee && (tick.kind === 'tick' || view.coveredBy === 'STORE')
      // [PINV-8 · REVIEW-F #2231 S4-1/S4-3] A fee that exists is never hidden behind the tick or the store cover.
      ? <button type="button" className="sw-btn sw-btn-md sw-btn-outline" onClick={() => setShowOwnFee(true)}>{PRO_FEE_OWN_FEE_LINK}</button>
      : null}
    {!view.data && tick.kind === 'none' && view.coveredBy !== 'STORE' ? <div className="sw-card space-y-2 p-6">
      <p className="font-semibold">{noFee.title}</p>
      <p>{noFee.body}</p>
      {noFee.action === 'AGREEMENT' ? <ReviewAgreementButton /> : null}
    </div> : null}
  </div>;
}
